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
import { POSES, type Pose } from './character/expressions';
import { isTravelWorthAnimating, planTravel, sampleTravel, type TravelPlan, type TravelSample } from './character/travel';
import {
  CHARACTER_CANVAS, bootstrapCharacterFrame, characterLayout, characterTransform,
  measureCharacterAnchor, setCharacterRenderFailed, type CharacterFrame,
} from './anchors';
export { signalBloub } from './events';
export { measureHomeTarget } from './anchors';

function centerFrame(): CharacterFrame {
  if (typeof window === 'undefined') return { x: 0, y: 0, size: 112 };
  return bootstrapCharacterFrame(window.visualViewport ?? { width: window.innerWidth, height: window.innerHeight });
}

class CharacterBoundary extends React.Component<{ children: React.ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

type Phase = 'loading' | 'travelling' | 'docked' | 'hidden';

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

    let frameId = 0;
    let rafId = 0;
    let animateNext = false;
    let occupied: HTMLElement | null = null;
    let observed: HTMLElement | null = null;
    let running = false;
    const epoch = performance.now();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule(false));

    const writeFrame = (frame: CharacterFrame) => {
      frameRef.current = frame;
      if (character.current) character.current.style.transform = characterTransform(frame);
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
      const viewport = {
        w: window.visualViewport?.width ?? window.innerWidth,
        h: window.visualViewport?.height ?? window.innerHeight,
      };

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

    const measure = () => {
      frameId = 0;
      const animate = animateNext;
      animateNext = false;
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
      const target = measureCharacterAnchor();
      if (observed !== (target?.element ?? null)) {
        if (observed) resizeObserver?.unobserve(observed);
        observed = target?.element ?? null;
        if (observed) resizeObserver?.observe(observed);
      }
      const pending = !readyRef.current || characterLayout.pending() || !!target?.busy;
      mascot.activity('anchor-loading', pending ? 'loading' : null);
      if (!completedRef.current && pending) {
        // Still waiting on the real page. The character holds the centre of
        // the viewport at full size and gets on with being alive there — this
        // is the one moment it has the screen to itself.
        writeFrame(centerFrame());
        return;
      }
      // During a lazy-route handoff keep the same node at its last position.
      // Registration wakes this observer as soon as the real header exists.
      if (!target || (characterLayout.pending() && target.kind === 'top-fallback')) return;
      if (occupied !== target.element) {
        occupied?.removeAttribute('data-bloub-occupied');
        occupied = target.element;
      }
      occupied.setAttribute('data-bloub-occupied', 'true');

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

      const plan = planTravel(last, next, { reduced: reducedRef.current, boot, continuation: !!inFlight });
      if (!animate && !boot && !inFlight) {
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

    function schedule(animate = false) {
      animateNext = animateNext || animate;
      if (!frameId) frameId = window.requestAnimationFrame(measure);
    }
    scheduleRef.current = schedule;

    const unsubscribe = characterLayout.subscribe(() => schedule(true));
    const onResize = () => schedule(false);
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
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    document.addEventListener('scroll', onResize, true);
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
      window.cancelAnimationFrame(frameId);
      journeyRef.current = null;
      mascot.activity('anchor-loading', null);
      mascot.activity('anchor-travel', null);
      occupied?.removeAttribute('data-bloub-occupied');
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
      document.removeEventListener('scroll', onResize, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(BLOUB_EVENT, onState);
    };
  }, [failed]);

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
      data-reduced-motion={reduced ? 'true' : 'false'} data-page-visible={pageVisible ? 'true' : 'false'}
      data-bloub-rendered={failed ? 'false' : 'true'} data-mascot-state={expression.state} aria-live="polite" aria-busy={!failed && phase === 'loading'}>
      <div className="lv-app-intro__veil" aria-hidden="true" />
      <div ref={character} className="lv-app-intro__character"
        style={{ width: CHARACTER_CANVAS, height: CHARACTER_CANVAS, transform: characterTransform(frameRef.current) }}>
        <CharacterBoundary onFailure={() => setFailed(true)}>
          <BloubHome ref={handle} state={expression.state} reduced={reduced} className="h-full w-full" />
        </CharacterBoundary>
      </div>
      {!failed && phase === 'loading' ? <span className="sr-only">{loc('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…')}</span> : null}
    </div>
  );
}
