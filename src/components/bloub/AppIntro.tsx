import React from 'react';
import { useLocation } from 'react-router-dom';
import { useMascotReducedMotion } from './useMascotReducedMotion';
import { useLanguage } from '../../LanguageContext';
import BloubHome, { type CharacterHandle } from './BloubHome';
import { mascot, type MascotState } from '../../lib/mascot';
import { BLOUB_EVENT, bloubDuration, isBloubState, canonicalBloubState } from './events';
import { sampleCharacter } from './character/engine';
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

  /** What the face is blending FROM, and since when. Kept in a ref because it
   * changes on the animation clock, not on React's — pushing it through state
   * would re-render the tree on every expression change for no benefit. */
  const blend = React.useRef<{ from: MascotState | null; state: MascotState; since: number; sequence: number }>({
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
      from: prev.state === expression.state ? prev.from : prev.state,
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
    };

    /**
     * The loop. It does three things and nothing else: advance the journey if
     * one is in flight, sample the character for this instant, and hand the
     * result to the renderer. It holds no state of its own, so the frame drawn
     * after a long pause is simply the frame that moment of the clock
     * describes — there is nothing to resynchronise.
     */
    const tick = (now: number) => {
      rafId = running ? window.requestAnimationFrame(tick) : 0;
      let travel: TravelSample | null = null;
      const journey = journeyRef.current;
      if (journey) {
        const elapsed = (now - journey.startedAt) / 1000;
        travel = sampleTravel(journey.plan, elapsed);
        writeFrame({ x: travel.x, y: travel.y, size: travel.size });
        if (travel.phase === 'done') finishJourney();
      }
      const b = blend.current;
      handle.current?.apply(sampleCharacter({
        t: (now - epoch) / 1000,
        state: b.state,
        from: b.from,
        age: (now - b.since) / 1000,
        travel,
        reduced: reducedRef.current,
      }));
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
      const plan = planTravel(last, next, { reduced: reducedRef.current, boot });
      if (!isTravelWorthAnimating(plan)) {
        // A relayout of a few pixels is not a journey. Snapping here is
        // correct: animating it would launch the character across the screen
        // every time a keyboard opened.
        if (!journeyRef.current) writeFrame(next);
        return;
      }
      if (!animate && !boot) {
        writeFrame(next);
        if (!journeyRef.current) { setPhase('docked'); }
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
