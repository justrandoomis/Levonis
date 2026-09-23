import React from 'react';
import { useLocation } from 'react-router-dom';
import { useMascotReducedMotion } from './useMascotReducedMotion';
import { useLanguage } from '../../LanguageContext';
import BloubHome, { type CharacterHandle } from './BloubHome';
import { mascot, type MascotState } from '../../lib/mascot';
import { BLOUB_EVENT, bloubDuration, isBloubState, canonicalBloubState } from './events';
import { sampleCharacter } from './character/engine';
import {
  NO_ATTENTION, attentionFrom, engagementAfter, followAttention, releaseDelay, type Attention,
} from './character/attention';
import { readPointer, watchPointer } from './pointer';
import { watchInterest, centreOf, type InterestTarget } from './interest';
import { isMascotHiddenRoute } from './MotionCharacterAnchor';
import { POSES, type Pose } from './character/expressions';
import { isTravelWorthAnimating, planTravel, sampleTravel, type TravelFrame, type TravelPlan, type TravelSample } from './character/travel';
import {
  CHARACTER_CANVAS, appearsInsteadOfTravelling, bootstrapCharacterFrame, characterLayout, characterTransform, layoutViewport,
  measureCharacterAnchor, setCharacterBooting, setCharacterRenderFailed, visibleViewport,
  type AnchorKind, type CharacterAnchor, type CharacterFrame,
} from './anchors';
import { ENTRANCE_ORIGIN, playEntrance } from './character/entrance';
export { signalBloub } from './events';
export { measureHomeTarget } from './anchors';

function centerFrame(): CharacterFrame {
  if (typeof window === 'undefined') return { x: 0, y: 0, size: 112 };
  // `visibleViewport()` hands back the visible area with its origin already
  // carried out, so this frame is in the same layout coordinates every anchor
  // rectangle is in. See the coordinate-space note in anchors.ts.
  return bootstrapCharacterFrame(visibleViewport());
}

/**
 * HOW LONG THE CHARACTER WILL WAIT FOR A PAGE THAT MAY NEVER ARRIVE.
 *
 * The bootstrap pin — full size, dead centre — is the right answer for the
 * first second of a cold load and the wrong answer for ever. Its only exit was
 * a readiness flag owned by a promise, so one request whose body stalled left
 * the character parked at 320px in the middle of a page the viewer had already
 * been reading for a minute, re-centring itself on every scroll and every
 * rotation. That is a UI state with an unbounded lifetime, which is a hang.
 *
 * The deadline is the exit: comfortably longer than any real first paint, far
 * shorter than a wait nobody is ever going to be released from. It is a SAFETY
 * NET, not the mechanism — the ordinary path still docks the moment readiness
 * settles, and a failed request settles exactly like a successful one.
 */
const BOOT_PIN_MAX_MS = 6000;

/**
 * How long the character holds its position through a lazy-route handoff.
 *
 * Most focused pages bring their own header a few hundred milliseconds after
 * the reserved fallback slot appears, and docking on the slot only to dock
 * again on the header is two journeys for one navigation. Holding still is the
 * better answer — but only for as long as the handoff plausibly takes.
 */
const HANDOFF_MAX_MS = 3000;

/**
 * How long a docked character keeps its place after its anchor disappears.
 *
 * Long enough to cover a route change that unmounts one header and mounts
 * another a commit later, short enough that a coordinate from a dead layout
 * never becomes the character's permanent address.
 */
const ORPHAN_GRACE_MS = 700;

/**
 * A rotation does not finish when the event announcing it fires.
 *
 * iOS reports `resize` while the safe-area insets, the URL bar and the layout
 * viewport are all still moving, and both anchor slots are `clamp()`-pinned to
 * a constant box at every tablet width — so the ResizeObserver watching them
 * never fires for a rotation that moves the anchor 180px sideways. One
 * trailing measurement after the viewport stops changing is what makes the
 * rectangle the character docks to the FINAL one.
 */
const SETTLE_MS = 250;

/**
 * THE SAME JOURNEY, AIMED SOMEWHERE ELSE.
 *
 * A resize arriving mid-flight used to build a whole new plan with a fresh
 * `startedAt`. A continuous resize — a desktop window drag, an iPad rotation,
 * a keyboard sliding up — fires one of those every frame, so the journey was
 * restarted every frame: `elapsed` never reached `plan.total`, the journey
 * never finished, the corrective re-measure at rest never ran, and because the
 * scale curve deliberately does not begin until a tenth of the travel beat has
 * passed, one frame of progress moves the size by exactly zero. The body
 * trailed the anchor by a few frames and stayed the size it had been before
 * the viewport started moving. That is the crawl.
 *
 * Keeping `from`, the beat durations and the start time and replacing only the
 * DESTINATION leaves the clock running, so the journey still lands. The sample
 * shifts by the same few pixels the anchor moved — which is the correction —
 * and nothing about the departure replays.
 */
function retargetTravel(plan: TravelPlan, to: TravelFrame): TravelPlan {
  const dx = to.x + to.size / 2 - (plan.from.x + plan.from.size / 2);
  const dy = to.y + to.size / 2 - (plan.from.y + plan.from.size / 2);
  return { ...plan, to, distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

class CharacterBoundary extends React.Component<{ children: React.ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

type Phase = 'loading' | 'travelling' | 'docked' | 'hidden';

/**
 * A journey is only ever between two ORDINARY docks. A stage is never the end
 * of one — nor the start — because a stage is appeared at rather than flown
 * to (`appearsInsteadOfTravelling` in anchors.ts, and `appear` below). The
 * journey used to carry a `stage` flag so a descent onto the order
 * confirmation could celebrate when it landed; that descent is exactly what
 * the owner rejected, so the flag went with it.
 */
interface Journey {
  plan: TravelPlan;
  startedAt: number;
  boot: boolean;
}

/**
 * THE CHARACTER'S ONE LIFE.
 *
 * A single SVG is mounted here for the whole session and moved between
 * measured docks — bottom-centre while the navigation bar is up, top-centre on
 * the pages that hide it. It is never unmounted and never duplicated, so a
 * route change cannot produce the "one mascot vanishes, another appears"
 * effect: there is only ever the one, and it walks.
 *
 * Everything that moves is driven from the ONE requestAnimationFrame loop
 * below, which samples pure functions of the clock and writes the result
 * straight onto the DOM. The previous implementation split this between a CSS
 * `transition` for position and a set of `@keyframes` for the face, and that
 * split is the root of most of what the brief asks to fix: two clocks that
 * cannot see each other cannot coordinate, so the body moved while the face
 * sat still, and every loop in the face had a fixed period a viewer learns in
 * about ten seconds.
 */
export default function AppIntro({ ready }: { ready: boolean }) {
  const location = useLocation();
  const { loc } = useLanguage();
  const reduced = useMascotReducedMotion();
  const [phase, setPhase] = React.useState<Phase>('loading');
  const expression = React.useSyncExternalStore(mascot.subscribe, mascot.snapshot, mascot.snapshot);
  const [failed, setFailed] = React.useState(false);
  const [pageVisible, setPageVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden);

  const character = React.useRef<HTMLDivElement>(null);
  /** The wrapper the entrances animate — never the node above, whose
   *  `transform` is the character's position and has exactly one writer. */
  const pose = React.useRef<HTMLDivElement>(null);
  const entrance = React.useRef<Animation | null>(null);
  const handle = React.useRef<CharacterHandle>(null);
  const frameRef = React.useRef<CharacterFrame>(centerFrame());
  const journeyRef = React.useRef<Journey | null>(null);
  const completedRef = React.useRef(false);
  const readyRef = React.useRef(ready);
  const reducedRef = React.useRef(reduced);
  const scheduleRef = React.useRef<(animate?: boolean) => void>(() => {});
  const firstPath = React.useRef(location.pathname);

  /** The pose the last drawn frame resolved to. This, not a table entry, is
   * what the next blend starts from — see `CharacterInput.from`. */
  const livePose = React.useRef<Pose | null>(null);

  /**
   * THE GAZE, AS IT IS RIGHT NOW — not as the pointer says it should be.
   *
   * This is the only genuinely stateful thing in the character, and it has to
   * be: following is defined by the previous frame. Everything else is a pure
   * function of the clock. Keeping it in a ref rather than in state is what
   * makes §23 achievable — the pointer can move a hundred times a second and
   * React never learns about any of it.
   */
  const aim = React.useRef<Attention>(NO_ATTENTION);
  /** The control the character has noticed, if any (§9/§10), with the centre
   *  measured when the pointer arrived rather than every frame. */
  const interest = React.useRef<InterestTarget | null>(null);
  /**
   * How long this particular disengagement takes, in seconds — re-rolled on
   * every release so the character never lets go on a schedule the user could
   * learn (§7). Math.random is right here and nowhere else in the character:
   * this is the one value that must NOT be reproducible from the clock, or the
   * irregularity would be the same irregularity every session.
   */
  const hold = React.useRef(releaseDelay(0.5));
  const lastActivity = React.useRef(0);

  /** What the face is blending FROM, and since when. Kept in a ref because it
   * changes on the animation clock, not on React's — pushing it through state
   * would re-render the tree on every expression change for no benefit. */
  const blend = React.useRef<{ from: Pose | null; state: MascotState; since: number; sequence: number }>({
    from: null, state: expression.state, since: 0, sequence: expression.sequence,
  });

  /**
   * THE ONLY WRITER OF `transform` ON THIS NODE.
   *
   * It used to have two: this imperative write, on the animation clock, and
   * React's own inline style, on the render clock. React's style diff compares
   * the string from the PREVIOUS render with the string from this one, so a
   * render that started mid-journey and committed a frame later put back the
   * position the ref held when the render began — a backwards jump of one
   * render's worth of travel, and the only way a stale frame could ever reach
   * the DOM. The inline style no longer carries `transform` at all; the layout
   * effect below re-asserts the LIVE frame before every paint instead, which
   * is always at least as fresh as what a render could have produced.
   */
  const writeFrame = React.useCallback((frame: CharacterFrame) => {
    frameRef.current = frame;
    if (character.current) character.current.style.transform = characterTransform(frame);
  }, []);

  React.useLayoutEffect(() => { writeFrame(frameRef.current); });

  React.useLayoutEffect(() => {
    readyRef.current = ready;
    mascot.activity('bootstrap', ready ? null : 'loading');
    scheduleRef.current(true);
  }, [ready]);

  React.useLayoutEffect(() => { reducedRef.current = reduced; }, [reduced]);

  // Tell the anchors whether there is a character to expect. They keep the
  // Home slot empty while there is, so nothing competes with it for identity.
  React.useLayoutEffect(() => {
    setCharacterRenderFailed(failed);
    return () => setCharacterRenderFailed(false);
  }, [failed]);

  /**
   * AND WHETHER IT IS THE BOOT LOADER RIGHT NOW. While it is, a `route` busy
   * wait is the character's to show — the overlay stands down rather than
   * drawing a spinner over it (see `booting` in anchors.ts). Not while the
   * route hides the character: the admin panel shows no intro at all, and a
   * wait there must still get an indicator.
   */
  const routeHidden = isMascotHiddenRoute(location.pathname);
  React.useLayoutEffect(() => {
    setCharacterBooting(!failed && phase === 'loading' && !routeHidden);
  }, [failed, phase, routeHidden]);
  React.useLayoutEffect(() => () => setCharacterBooting(false), []);

  // The expression the controller has selected, noted the moment it changes so
  // the engine can blend out of the previous one. `sequence` is part of the
  // key: two errors in a row are two reactions, and the second must replay.
  React.useLayoutEffect(() => {
    const prev = blend.current;
    if (prev.state === expression.state && prev.sequence === expression.sequence) return;
    blend.current = {
      // Wherever the face actually is right now, including halfway through the
      // blend this one is interrupting.
      from: livePose.current ?? POSES[prev.state],
      state: expression.state,
      since: performance.now(),
      sequence: expression.sequence,
    };
  }, [expression.state, expression.sequence]);

  React.useEffect(() => {
    if (failed) return;
    mascot.setVisible(!document.hidden);

    /**
     * A MEASUREMENT IS OWED THIS FRAME. Not a handle to a `requestAnimationFrame`
     * of its own — see `schedule` and the read phase in `tick`.
     */
    let measurePending = false;
    let rafId = 0;
    let animateNext = false;
    let occupied: HTMLElement | null = null;
    /**
     * The KIND of the dock the character last committed to. Sticky on
     * purpose: when the confirmation stage unmounts, `occupied` is cleared the
     * moment its element leaves the document, and the next dock must still be
     * able to tell that it is being arrived at FROM a stage.
     */
    let occupiedKind: AnchorKind | null = null;
    let observed: HTMLElement | null = null;
    let running = false;
    const epoch = performance.now();
    let observedContainer: HTMLElement | null = null;
    let settleTimer = 0;
    /** When measure() first REFUSED to dock, so every refusal has a deadline. */
    let waitingSince = 0;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { refreshViewport(); schedule(false); });

    /**
     * Come back on our own, once, after `ms`.
     *
     * Every refusal below is waiting on something that may never happen, and
     * nothing else in the system is going to wake this measurement if it does
     * not. This is a single-shot timer that is reset, never stacked, so it can
     * never become a poll: at most one pending measurement exists at a time.
     */
    const remeasureAfter = (ms: number) => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => { settleTimer = 0; schedule(false); }, ms);
    };

    /**
     * THE LAYOUT VIEWPORT, READ WHEN IT CHANGES AND NOT SIXTY TIMES A SECOND.
     *
     * `aimAt` needs the viewport as the denominator for the gaze's falloff, and
     * it was calling `layoutViewport()` — which reads
     * `documentElement.clientWidth/clientHeight` — inside the loop. Reading
     * layout is only cheap when the browser has nothing to recompute, and this
     * loop had already written `style.transform` onto the character earlier in
     * the SAME frame while travelling. A write followed by a read is a FORCED
     * SYNCHRONOUS REFLOW: the browser must stop and lay the whole document out
     * again before it can answer, every frame, on a phone, on every route.
     *
     * The owner's report of it was «التعليك lagging والتشنج في الموقع يحدث بين
     * فترات متقاربه ومستمره» — sticking and freezing that recurs at short,
     * continuous intervals, with nobody touching anything.
     *
     * The value cannot change without one of the listeners registered at the
     * bottom of this effect firing. A rotation, a URL-bar collapse and a
     * pinch-zoom all reach `onResize`; anything that changes the root element's
     * own box reaches the ResizeObserver already watching
     * `document.documentElement`; and a scrollbar appearing does both. So a
     * cache refreshed from those is not an approximation of the live value, it
     * IS the live value — measured at the moments it can move, instead of at
     * sixty moments a second when it cannot.
     */
    let viewportSize = layoutViewport();
    const refreshViewport = () => { viewportSize = layoutViewport(); };

    const occupy = (element: HTMLElement | null, kind?: AnchorKind) => {
      if (element && kind) occupiedKind = kind;
      if (occupied === element) return;
      occupied?.removeAttribute('data-bloub-occupied');
      occupied = element;
      occupied?.setAttribute('data-bloub-occupied', 'true');
    };

    const finishJourney = () => {
      journeyRef.current = null;
      setPhase('docked');
      mascot.navigationComplete();
      // Any sub-journey drift the anchor accumulated while the character was
      // in the air is applied now, at rest, where a few pixels are invisible.
      // Applying it mid-flight would have meant replacing the plan, and
      // replacing the plan replays the departure.
      schedule(false);
    };

    /**
     * The loop. It does three things and nothing else: advance the journey if
     * one is in flight, sample the character for this instant, and hand the
     * result to the renderer. It holds no state of its own, so the frame drawn
     * after a long pause is simply the frame that moment of the clock
     * describes — there is nothing to resynchronise.
     */
    /**
     * WHAT THE CHARACTER IS LOOKING AT THIS FRAME.
     *
     * One read of the pointer tracker, one arithmetic pass, no layout. The
     * character's own centre comes from the frame it is already drawing, so
     * the whole of §4, §5 and §6 costs no measurement at all.
     *
     * A noticed CONTROL outranks the bare pointer: once the user has arrived
     * on the checkout button, the thing worth looking at is the button, not
     * the four pixels of cursor hovering over it. That is what makes the
     * anticipation in §10 land on the control rather than wobbling around it.
     */
    const aimAt = (now: number, dt: number) => {
      const pointer = readPointer();
      const target = interest.current;
      const frame = frameRef.current;
      const centre = { x: frame.x + frame.size / 2, y: frame.y + frame.size / 2 };
      // THE LAYOUT VIEWPORT, because `centre` came from a client rectangle
      // and `pointer` from clientX/clientY. Dividing a layout-space distance
      // by the VISUAL viewport's diagonal put two coordinate spaces in one
      // fraction: a pinch-zoom or a raised keyboard shrinks the visual
      // viewport while leaving every client coordinate exactly where it was,
      // so the character's reach changed without anything it measures moving.
      const viewport = viewportSize;

      if (pointer.present && pointer.movedAt > lastActivity.current) {
        // New activity: re-roll how long this engagement will be held, so the
        // release is never twice the same length.
        lastActivity.current = pointer.movedAt;
        hold.current = releaseDelay(Math.random());
      }

      const point = target
        ? { x: target.x, y: target.y }
        : pointer.present
          ? { x: pointer.x, y: pointer.y }
          : null;

      // A touch that is still down is live attention; one that has been
      // released decays like a mouse that stopped moving. Neither ever snaps.
      const since = (now - (lastActivity.current || now)) / 1000;
      const engagement = target
        ? 1
        : pointer.down
          ? 1
          : engagementAfter(since, hold.current);

      const want = attentionFrom({ point, center: centre, viewport, engagement, deliberate: !!target });
      aim.current = followAttention(aim.current, want, dt, reducedRef.current ? 1.6 : 1);
      return aim.current;
    };

    let lastFrameAt = 0;
    /**
     * When the character first appeared. Null once the opening is spent, so
     * `introOverlay` is not called sixty times a second for the rest of the
     * session to be told the same nothing.
     */
    let introAt: number | null = performance.now();

    const tick = (now: number) => {
      rafId = running ? window.requestAnimationFrame(tick) : 0;
      /**
       * THE READ PHASE, AND IT IS FIRST BECAUSE THE ORDER IS THE WHOLE FIX.
       *
       * `measure` asks the browser real questions about layout —
       * `getBoundingClientRect`, `getComputedStyle`, `offsetParent`. Those are
       * cheap only when the browser has nothing to recompute. It used to run
       * on a `requestAnimationFrame` of its OWN, queued from a capture-phase
       * scroll listener, which meant it landed in the same frame as this loop
       * and always AFTER it: `tick` re-arms itself on its first line, so a
       * scroll event fired after frame N put `measure` behind `tick` in frame
       * N+1. By then this function had already written `style.transform` onto
       * the character and pushed six attributes onto the SVG. A write followed
       * by a read of layout is a FORCED SYNCHRONOUS REFLOW — the browser must
       * stop and lay the whole document out again before it can answer — once
       * per scroll frame, on every route, on a phone. That is the owner's
       * «التعليك lagging والتشنج ... بين فترات متقاربه ومستمره».
       *
       * Folding it in here removes the reflow BY CONSTRUCTION rather than by
       * removing a measurement: every question is asked before this frame
       * writes anything, so there is never a write for a read to follow. The
       * invariant the journey machinery depends on is untouched — the flag is
       * consumed here and nowhere else, so `measure` still runs at most once
       * per frame, and a burst of scroll events still collapses onto one pass.
       */
      if (measurePending) {
        measurePending = false;
        measure();
      }
      // Clamped so a tab that was throttled does not resume with a single
      // enormous step that teleports the gaze — the very thing §4 forbids.
      const dt = lastFrameAt ? Math.min(0.05, Math.max(0, (now - lastFrameAt) / 1000)) : 1 / 60;
      lastFrameAt = now;
      if (introAt !== null && now - introAt > 1400) introAt = null;
      let travel: TravelSample | null = null;
      const journey = journeyRef.current;
      if (journey) {
        const elapsed = (now - journey.startedAt) / 1000;
        travel = sampleTravel(journey.plan, elapsed);
        // The preference can change WHILE a journey is in flight, and the plan
        // carries the flag it was built with. Flattening the deformation here
        // rather than re-planning keeps the character on its path — it must
        // still arrive — while honouring the preference from this frame on.
        if (reducedRef.current && !journey.plan.reduced) travel = { ...travel, stretch: 0, trail: 0, squash: 0 };
        writeFrame({ x: travel.x, y: travel.y, size: travel.size });
        if (travel.phase === 'done') finishJourney();
      }
      const b = blend.current;
      const render = sampleCharacter({
        t: (now - epoch) / 1000,
        state: b.state,
        from: b.from,
        age: (now - b.since) / 1000,
        travel,
        attention: aimAt(now, dt),
        // §18: the opening runs from the character's own first frame and is
        // over inside 1.4s, before any journey can start. `introAt` is stamped
        // when this loop is created — once per page load — so a client-side
        // route change, which never remounts this component, cannot replay it.
        intro: introAt === null ? null : (now - introAt) / 1000,
        reduced: reducedRef.current,
      });
      livePose.current = render.pose;
      handle.current?.apply(render);
    };

    const start = () => {
      if (running) return;
      running = true;
      rafId = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
    };

    /**
     * THE FRAME'S ONE MEASUREMENT. Called only from the read phase at the top
     * of `tick`, never scheduled on a frame of its own. Everything it asks the
     * browser is asked before `writeFrame` below, and before this pass writes
     * anything either: reads first, then writes, in that order, always.
     */
    /**
     * ARRIVING WITHOUT A JOURNEY — the only way the character reaches a stage
     * or leaves one (`appearsInsteadOfTravelling`).
     *
     * One write of the destination frame, then an entrance played on the pose
     * wrapper by the compositor: transform and opacity, nothing that can be
     * held up by the main thread that is at this very moment unmounting a
     * checkout and mounting its confirmation. Landing on a stage is what the
     * stage was raised for, so it celebrates (`navigationComplete('stage')`);
     * landing back on a dock is ordinary punctuation.
     */
    const appear = (target: CharacterAnchor & { frame: CharacterFrame }) => {
      journeyRef.current = null;
      writeFrame(target.frame);
      setPhase('docked');
      mascot.activity('anchor-travel', null);
      const stage = target.kind === 'stage';
      if (!document.hidden) entrance.current = playEntrance(pose.current, stage ? 'stage' : 'dock', reducedRef.current, entrance.current);
      mascot.navigationComplete(stage ? 'stage' : 'route');
    };

    const measure = () => {
      const animate = animateNext;
      animateNext = false;
      const now = performance.now();
      // The noticed control may have scrolled since the pointer arrived on it.
      // Re-measured HERE, on the same rAF-throttled pass the character's own
      // dock uses, and never inside the draw loop.
      const noticed = interest.current;
      if (noticed) {
        if (!noticed.element.isConnected) interest.current = null;
        else {
          const centre = centreOf(noticed.element);
          if (centre) { noticed.x = centre.x; noticed.y = centre.y; }
        }
      }
      if (occupied && !occupied.isConnected) {
        // THE STAGE WENT AWAY — the customer left the confirmation. It is not
        // left standing where the stage used to be, on top of whatever page
        // comes next, while that page's own dock is still loading: it goes,
        // and `appear` brings it back on the next dock.
        if (occupiedKind === 'stage') {
          journeyRef.current = null;
          setPhase('hidden');
        }
        occupy(null);
      }
      const target = measureCharacterAnchor();
      if (observed !== (target?.element ?? null)) {
        if (observed) resizeObserver?.unobserve(observed);
        observed = target?.element ?? null;
        if (observed) resizeObserver?.observe(observed);
      }
      // WATCH THE BOX THAT MOVES THE ANCHOR, NOT ONLY THE ANCHOR.
      // Both slots are `clamp()`-pinned to a constant size at every width above
      // about 474px, so on a tablet the anchor's own box is byte-identical in
      // portrait and landscape and an observer on it alone is silent through
      // the one event that moves it furthest. Its layout container is not.
      const container = target ? (target.element.offsetParent as HTMLElement | null) ?? target.element.parentElement : null;
      if (observedContainer !== container) {
        if (observedContainer) resizeObserver?.unobserve(observedContainer);
        observedContainer = container;
        if (observedContainer) resizeObserver?.observe(observedContainer);
      }
      const pending = !readyRef.current || characterLayout.pending() || !!target?.busy;
      mascot.activity('anchor-loading', pending ? 'loading' : null);

      // NOTHING TO DOCK TO AT ALL, AND NOWHERE IT HAS EVER DOCKED.
      // The viewport centre is the character's defined home before there is a
      // page, so holding it here is a POSITION and not a wait — it is
      // recomputed absolutely on every pass, and there is no other frame that
      // would be more correct. This is the one refusal with no deadline.
      if (!target && !completedRef.current) {
        writeFrame(centerFrame());
        return;
      }

      /**
       * ORPHANED: DOCKED SOMEWHERE THAT NO LONGER EXISTS.
       *
       * Every anchor has gone — a header unmounted a commit before its
       * replacement mounts, typically. Holding still covers that, and used to
       * be all this did, which meant a window that never closed left the
       * character drawn at a coordinate belonging to a dead layout while the
       * page scrolled underneath it. Past the grace the honest answer is that
       * it has nowhere legitimate to be, so it is not drawn. It comes back,
       * docked, the instant an anchor registers.
       */
      if (!target) {
        if (!waitingSince) waitingSince = now;
        const left = ORPHAN_GRACE_MS - (now - waitingSince);
        if (left > 0) { remeasureAfter(left); return; }
        occupy(null);
        journeyRef.current = null;
        setPhase('hidden');
        return;
      }

      /**
       * WHY A DOCK IS BEING REFUSED — AND THEREFORE FOR HOW MUCH LONGER.
       *
       * Both of these are right for a moment and indefensible for a minute,
       * and both used to be a bare `return` whose only exit was an upstream
       * promise settling. They now share one stopwatch, so "still booting" and
       * "a signal that is never going to arrive" stop being the same state.
       */
      const refusal: 'boot' | 'handoff' | null =
        !completedRef.current && pending ? 'boot'
          : pending && target.kind === 'top-fallback' ? 'handoff'
            : null;

      if (refusal) {
        if (!waitingSince) waitingSince = now;
        const left = (refusal === 'boot' ? BOOT_PIN_MAX_MS : HANDOFF_MAX_MS) - (now - waitingSince);
        if (left > 0) {
          // 'boot' holds the viewport centre; 'handoff' holds whatever the
          // character already has, because it is standing on a real dock.
          if (refusal === 'boot') writeFrame(centerFrame());
          remeasureAfter(left);
          return;
        }
        // Past the deadline with a real anchor in hand: dock SILENTLY. Not a
        // journey — a first dock would plan a 0.34s wind-up and a cross-screen
        // travel, and a mascot barging into a page the viewer has been reading
        // for ten seconds is worse than one that was merely late.
        occupy(target.element, target.kind);
        writeFrame(target.frame);
        journeyRef.current = null;
        completedRef.current = true;
        waitingSince = 0;
        setPhase('docked');
        mascot.navigationComplete();
        return;
      }
      waitingSince = 0;
      const previous = occupied;
      const previousKind = occupiedKind;
      occupy(target.element, target.kind);

      // A STAGE IS APPEARED AT. Decided before anything below can plan a
      // journey, and only when the DOCK changed: a stage that merely scrolled
      // is re-positioned by the ordinary path, never popped again.
      if (target.element !== previous && appearsInsteadOfTravelling(previousKind, target.kind)) {
        completedRef.current = true;
        appear(target);
        return;
      }

      const next = target.frame;
      const last = frameRef.current;
      const boot = !completedRef.current;
      completedRef.current = true;

      // WHERE THE CHARACTER IS ALREADY HEADED, not where it happens to be
      // right now. Comparing against its live position instead meant that a
      // re-measure taken while it was mid-flight and passing near the NEW
      // anchor looked like "nothing to do" — and the journey then carried it
      // on to the OLD one, past the dock it was supposed to take.
      const inFlight = journeyRef.current;
      const heading = inFlight ? inFlight.plan.to : last;

      // IS THE DESTINATION ACTUALLY SOMEWHERE ELSE? That is the only question
      // here, and it is asked of the destination — never of the character's
      // live position, which during a journey is a moving target that sweeps
      // past all sorts of places. A drift too small to be a journey is not one
      // whether or not the character is already moving: mid-flight it is
      // ignored outright, because the only way to apply it is to replace the
      // plan, and a replaced plan replays the departure — a fresh gaze swing
      // and a fresh deceleration, to cover a pixel. `finishJourney` schedules
      // the measurement that puts it right, at rest.
      if (!isTravelWorthAnimating(planTravel(heading, next, { reduced: reducedRef.current }))) {
        if (!inFlight) writeFrame(next);
        return;
      }

      // A VIEWPORT THAT IS STILL MOVING MUST NOT RESTART THE JOURNEY.
      // Re-planning here resets `startedAt`, and a resize that fires every
      // frame therefore resets it every frame — the journey never reaches
      // `plan.total`, never finishes, and its size never leaves the value it
      // had when the viewport started moving. Retargeting keeps the clock and
      // replaces only the destination, so it still lands, on the new anchor.
      // A route change (animate) is a genuinely new intention and still plans.
      if (inFlight && !animate) {
        journeyRef.current = { ...inFlight, plan: retargetTravel(inFlight.plan, next) };
        return;
      }

      const plan = planTravel(last, next, { reduced: reducedRef.current, boot, continuation: !!inFlight });
      if (!animate && !boot) {
        writeFrame(next);
        setPhase('docked');
        return;
      }
      if (document.hidden) {
        writeFrame(next);
        setPhase('docked');
        mascot.navigationComplete();
        return;
      }
      // The gaze is told where it is going before anything moves; the travel
      // plan then holds that direction for the whole journey.
      mascot.look(
        next.x + next.size / 2 - last.x - last.size / 2,
        next.y + next.size / 2 - last.y - last.size / 2,
      );
      journeyRef.current = { plan, startedAt: performance.now(), boot };
      setPhase('travelling');
      mascot.activity('anchor-travel', target.kind === 'bottom-home' ? 'returning' : 'navigating');
      start();
    };

    /**
     * ASK FOR A MEASUREMENT ON THE NEXT FRAME. A FLAG, NOT A FRAME.
     *
     * This used to own a `requestAnimationFrame` of its own, which is how the
     * measurement ended up behind the draw in the same frame (see the read
     * phase in `tick`). It now raises a flag the loop consumes at the top of
     * its next turn, so the collapsing behaviour is identical — a hundred
     * scroll events between two frames are still one measurement — and the
     * ordering is fixed rather than incidental.
     *
     * The loop has to be turning for the flag to be read. It always is while
     * the tab is visible; a hidden tab serves frames to nobody, and
     * `onVisibility` re-arms the loop and the measurement together.
     */
    function schedule(animate = false) {
      animateNext = animateNext || animate;
      measurePending = true;
      if (!document.hidden) start();
    }
    scheduleRef.current = schedule;

    const unsubscribe = characterLayout.subscribe(() => schedule(true));
    /**
     * The anchor may have MOVED — re-measure, and re-measure again when the
     * movement stops.
     *
     * This is the handler for scrolling as well as for resizing, and scrolling
     * is the common case: the capture-phase listener below fires for every
     * scroller in the app. `schedule` collapses the burst onto one rAF, so the
     * cost is one measurement per frame while a finger is moving, not one per
     * event.
     */
    const onScroll = () => {
      schedule(false);
      // ...and once more when it stops. See SETTLE_MS: the geometry this event
      // announces is not the geometry the page ends up with.
      remeasureAfter(SETTLE_MS);
    };

    /**
     * The VIEWPORT ITSELF changed size — a rotation, a window resize, a
     * keyboard, a URL bar collapsing.
     *
     * Only these refresh the cached size, and that distinction is the point.
     * Refreshing it on scroll too would put `clientWidth`/`clientHeight` — a
     * forced layout read — back on the hottest path in the app, which is the
     * thing this cache exists to get off it. A scroll moves the page past the
     * viewport; it does not resize the viewport.
     */
    const onResize = () => {
      // Before the measurement, not after: `measure()` and the loop both read
      // the cached size, and a stale denominator for one frame is a gaze that
      // aims at where the screen used to be.
      refreshViewport();
      onScroll();
    };
    const onVisibility = () => {
      setPageVisible(!document.hidden);
      mascot.setVisible(!document.hidden);
      if (document.hidden) {
        stop();
        // A journey interrupted by the tab going away is completed, not
        // abandoned: the character must not be found mid-flight on return.
        if (journeyRef.current) { writeFrame(journeyRef.current.plan.to); finishJourney(); }
        setPhase(completedRef.current ? 'docked' : 'loading');
        mascot.activity('anchor-travel', null);
      } else {
        refreshViewport();
        start();
        schedule(false);
      }
    };
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: unknown; durationMs?: unknown }>).detail;
      if (!detail || !isBloubState(detail.state) || document.hidden) return;
      mascot.trigger(canonicalBloubState(detail.state), bloubDuration(detail.durationMs));
    };

    /**
     * §4, §5, §6, §9, §10 — THE CHARACTER'S SENSES.
     *
     * Both watchers are passive and capture-phase, both write into plain
     * objects, and neither of them touches React. The loop reads them once a
     * frame. Nothing here can delay a scroll or swallow a tap.
     */
    const unwatchPointer = watchPointer();
    const unwatchInterest = watchInterest({
      enter(target) {
        interest.current = target;
        lastActivity.current = performance.now();
        // Curiosity is HELD for as long as the control is under the pointer,
        // and it sits one rung above idle — so it can never interrupt an
        // error, a journey or a success (§22).
        mascot.activity('interest', 'curious');
      },
      leave() {
        interest.current = null;
        lastActivity.current = performance.now();
        hold.current = releaseDelay(Math.random());
        mascot.activity('interest', null);
      },
      activate(kind) {
        // The press itself. A quantity press is answered by the controller's
        // own escalation, which knows about the run; a CTA gets the small
        // physical acknowledgement a press deserves, and whatever the request
        // actually does then outranks it.
        if (kind === 'cta') mascot.trigger('tap');
      },
    });

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onScroll);
    // The capture-phase listener is the app's every scroller at once, and it is
    // still the only thing that catches an in-page layout shift moving a sticky
    // header. It stays until something cheaper covers that case.
    document.addEventListener('scroll', onScroll, true);
    // The layout viewport itself. Unlike the anchor slots — whose boxes are
    // clamp()-pinned to a constant at every tablet width — this changes on
    // every rotation and every URL-bar collapse, which is precisely when the
    // anchor moves furthest without changing size.
    resizeObserver?.observe(document.documentElement);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(BLOUB_EVENT, onState);
    writeFrame(frameRef.current);
    if (!document.hidden) start();
    schedule(true);

    return () => {
      unsubscribe();
      unwatchPointer();
      unwatchInterest();
      interest.current = null;
      aim.current = NO_ATTENTION;
      mascot.activity('interest', null);
      scheduleRef.current = () => {};
      stop();
      window.clearTimeout(settleTimer);
      measurePending = false;
      journeyRef.current = null;
      entrance.current?.cancel();
      entrance.current = null;
      mascot.activity('anchor-loading', null);
      mascot.activity('anchor-travel', null);
      occupied?.removeAttribute('data-bloub-occupied');
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onScroll);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(BLOUB_EVENT, onState);
    };
  }, [failed, writeFrame]);

  React.useEffect(() => {
    if (firstPath.current === location.pathname) return;
    firstPath.current = location.pathname;
    if (completedRef.current) mascot.trigger('navigating');
    scheduleRef.current(true);
  }, [location.pathname]);

  React.useEffect(() => {
    const beforeNavigate = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      mascot.trigger('navigating');
    };
    const invalid = () => mascot.trigger('warning');
    const offline = () => mascot.trigger('warning');
    document.addEventListener('click', beforeNavigate, true);
    document.addEventListener('invalid', invalid, true);
    window.addEventListener('offline', offline);
    return () => {
      document.removeEventListener('click', beforeNavigate, true);
      document.removeEventListener('invalid', invalid, true);
      window.removeEventListener('offline', offline);
      mascot.activity('bootstrap', null);
    };
  }, []);

  return (
    <div className="lv-app-intro" data-phase={failed ? 'hidden' : phase}
      /* THE ADMIN PANEL HAS NO CHARACTER. It is a workbench — dense tables and
         forms — and there the mascot is a green ball parked in the top bar,
         taking the vertical space those tables need. Hidden by ROUTE rather
         than unmounted: the journey state machine, its anchors and the veil it
         releases all stay intact, so entering and leaving /admin costs nothing
         and cannot strand the layer mid-travel. */
      data-route-hidden={isMascotHiddenRoute(location.pathname) ? 'true' : 'false'}
      data-reduced-motion={reduced ? 'true' : 'false'} data-page-visible={pageVisible ? 'true' : 'false'}
      data-bloub-rendered={failed ? 'false' : 'true'} data-mascot-state={expression.state} aria-live="polite" aria-busy={!failed && phase === 'loading'}>
      <div className="lv-app-intro__veil" aria-hidden="true" />
      <div ref={character} className="lv-app-intro__character"
        style={{ width: CHARACTER_CANVAS, height: CHARACTER_CANVAS }}>
        <div ref={pose} className="lv-app-intro__pose" style={{ transformOrigin: ENTRANCE_ORIGIN }}>
          <CharacterBoundary onFailure={() => setFailed(true)}>
            <BloubHome ref={handle} state={expression.state} reduced={reduced} className="h-full w-full" />
          </CharacterBoundary>
        </div>
      </div>
      {!failed && phase === 'loading' ? <span className="sr-only">{loc('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…')}</span> : null}
    </div>
  );
}
