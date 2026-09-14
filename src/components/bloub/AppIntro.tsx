import React from 'react';
import { useLocation } from 'react-router-dom';
import { useMascotReducedMotion } from './useMascotReducedMotion';
import { useLanguage } from '../../LanguageContext';
import BloubHome from './BloubHome';
import { mascot } from '../../lib/mascot';
import { BLOUB_EVENT, bloubDuration, isBloubState, canonicalBloubState } from './events';
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
  const reduced = useMascotReducedMotion();
  const [frame, setFrame] = React.useState<CharacterFrame>(centerFrame);
  const frameRef = React.useRef(frame);
  const [phase, setPhase] = React.useState<Phase>('loading');
  const expression = React.useSyncExternalStore(mascot.subscribe, mascot.snapshot, mascot.snapshot);
  const [failed, setFailed] = React.useState(false);
  const [pageVisible, setPageVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden);
  const completedRef = React.useRef(false);
  const readyRef = React.useRef(ready);
  const scheduleRef = React.useRef<(animate?: boolean) => void>(() => {});
  const firstPath = React.useRef(location.pathname);

  React.useLayoutEffect(() => {
    readyRef.current = ready;
    mascot.activity('bootstrap', ready ? null : 'loading');
    scheduleRef.current(true);
  }, [ready]);

  React.useEffect(() => {
    if (failed) return;
    mascot.setVisible(!document.hidden);
    // Reducing motion can cancel a CSS transition without transitionend.
    // Settle that same persistent node instead of leaving phase=travelling.
    if (reduced && completedRef.current) {
      setPhase('docked');
      mascot.navigationComplete();
    }
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
      mascot.navigationComplete();
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
      mascot.look(next.x + next.size / 2 - last.x - last.size / 2, next.y + next.size / 2 - last.y - last.size / 2);
      frameRef.current = next;
      setFrame(next);
      window.clearTimeout(settleTimer);
      if ((animate || boot) && !reduced && !document.hidden) {
        setPhase('travelling');
        mascot.activity('anchor-travel', target.kind === 'bottom-home' ? 'returning' : 'navigating');
        // Completion fallback only, never a readiness timer. Also covers a
        // cancelled CSS transition or identical rounded browser transforms.
        settleTimer = window.setTimeout(settle, 600);
      } else {
        setPhase('docked');
        mascot.navigationComplete();
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
      mascot.setVisible(!document.hidden);
      if (document.hidden) { window.clearTimeout(settleTimer); setPhase(completedRef.current ? 'docked' : 'loading'); mascot.activity('anchor-travel', null); }
      else schedule(false);
    };
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: unknown; durationMs?: unknown }>).detail;
      if (!detail || !isBloubState(detail.state) || document.hidden) return;
      mascot.trigger(canonicalBloubState(detail.state), bloubDuration(detail.durationMs));
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
      mascot.activity('anchor-loading', null);
      mascot.activity('anchor-travel', null);
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
  }, [reduced, failed]);

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
      <div className="lv-app-intro__character" style={{ width: CHARACTER_CANVAS, height: CHARACTER_CANVAS, transform: characterTransform(frame) }}>
        <CharacterBoundary onFailure={() => setFailed(true)}>
          <BloubHome state={expression.state} direction={expression.direction} sequence={expression.sequence} className="h-full w-full" />
        </CharacterBoundary>
      </div>
      {!failed && phase === 'loading' ? <span className="sr-only">{loc('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…')}</span> : null}
    </div>
  );
}
