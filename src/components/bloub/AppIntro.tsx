import React from 'react';
import { useLocation } from 'react-router-dom';
import { useReducedMotion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import BloubHome, { type BloubState } from './BloubHome';
import { BLOUB_EVENT, bloubDuration, isBloubState } from './events';
import {
  CHARACTER_CANVAS, bootstrapCharacterFrame, characterLayout, characterTransform,
  measureCharacterAnchor, type CharacterFrame,
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

/** One mounted SVG, moved by compositor transforms between measured slots.
 * Layout events schedule one measurement; CSS owns all animation frames.
 */
export default function AppIntro({ ready }: { ready: boolean }) {
  const location = useLocation();
  const { loc } = useLanguage();
  const reduced = !!useReducedMotion();
  const [frame, setFrame] = React.useState<CharacterFrame>(centerFrame);
  const frameRef = React.useRef(frame);
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [state, setState] = React.useState<BloubState>('thinking');
  const [failed, setFailed] = React.useState(false);
  const [pageVisible, setPageVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden);
  const completedRef = React.useRef(false);
  const readyRef = React.useRef(ready);
  const scheduleRef = React.useRef<(animate?: boolean) => void>(() => {});
  const transientTimer = React.useRef<number | null>(null);
  const idleState = React.useRef<BloubState>('thinking');
  const firstPath = React.useRef(location.pathname);

  const clearTransient = React.useCallback(() => {
    if (transientTimer.current !== null) window.clearTimeout(transientTimer.current);
    transientTimer.current = null;
  }, []);

  React.useLayoutEffect(() => {
    readyRef.current = ready;
    scheduleRef.current(true);
  }, [ready]);

  React.useEffect(() => {
    if (failed) return;
    let frameId = 0;
    let settleTimer = 0;
    let animateNext = false;
    let occupied: HTMLElement | null = null;
    let observed: HTMLElement | null = null;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule(false));
    const settle = () => {
      window.clearTimeout(settleTimer);
      if (!completedRef.current) return;
      setPhase('docked');
      if (transientTimer.current === null) setState(idleState.current);
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
      idleState.current = pending ? 'thinking' : 'idle';
      if (transientTimer.current === null) setState(idleState.current);
      if (!completedRef.current && pending) {
        const center = centerFrame();
        frameRef.current = center;
        setFrame(center);
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
      const changed = Math.abs(next.x - last.x) > 0.1 || Math.abs(next.y - last.y) > 0.1 || Math.abs(next.size - last.size) > 0.1;
      const boot = !completedRef.current;
      completedRef.current = true;
      if (!changed && !boot) return;
      frameRef.current = next;
      setFrame(next);
      window.clearTimeout(settleTimer);
      if ((animate || boot) && !reduced && !document.hidden) {
        setPhase('travelling');
        if (transientTimer.current === null) setState(pending ? 'thinking' : 'navigation');
        // Completion fallback only, never a readiness timer. Also covers a
        // cancelled CSS transition or identical rounded browser transforms.
        settleTimer = window.setTimeout(settle, 600);
      } else {
        setPhase('docked');
      }
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
      if (document.hidden) { clearTransient(); settle(); setState('idle'); }
      else schedule(false);
    };
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: unknown; durationMs?: unknown }>).detail;
      if (!detail || !isBloubState(detail.state) || document.hidden) return;
      clearTransient();
      setState(detail.state);
      if (detail.state !== 'idle') transientTimer.current = window.setTimeout(() => {
        transientTimer.current = null;
        setState(idleState.current);
      }, bloubDuration(detail.durationMs));
    };
    const onTransition = (event: TransitionEvent) => {
      if (event.propertyName === 'transform' && (event.target as Element)?.classList?.contains('lv-app-intro__character')) settle();
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    document.addEventListener('scroll', onResize, true);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('transitionend', onTransition);
    window.addEventListener(BLOUB_EVENT, onState);
    schedule(true);
    return () => {
      unsubscribe();
      scheduleRef.current = () => {};
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(settleTimer);
      clearTransient();
      occupied?.removeAttribute('data-bloub-occupied');
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
      document.removeEventListener('scroll', onResize, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('transitionend', onTransition);
      window.removeEventListener(BLOUB_EVENT, onState);
    };
  }, [reduced, failed, clearTransient]);

  React.useEffect(() => {
    if (firstPath.current === location.pathname) return;
    firstPath.current = location.pathname;
    clearTransient();
    if (completedRef.current) setState('navigation');
    scheduleRef.current(true);
  }, [location.pathname, clearTransient]);

  return (
    <div className="lv-app-intro" data-phase={failed ? 'hidden' : phase}
      data-reduced-motion={reduced ? 'true' : 'false'} data-page-visible={pageVisible ? 'true' : 'false'}
      data-bloub-rendered={failed ? 'false' : 'true'} aria-live="polite" aria-busy={!failed && phase === 'loading'}>
      <div className="lv-app-intro__veil" aria-hidden="true" />
      <div className="lv-app-intro__character" style={{ width: CHARACTER_CANVAS, height: CHARACTER_CANVAS, transform: characterTransform(frame) }}>
        <CharacterBoundary onFailure={() => setFailed(true)}>
          <BloubHome state={pageVisible ? state : 'idle'} className="h-full w-full" />
        </CharacterBoundary>
      </div>
      {!failed && phase === 'loading' ? <span className="sr-only">{loc('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…')}</span> : null}
    </div>
  );
}
