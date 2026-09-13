import React from 'react';
import { useLocation } from 'react-router-dom';
import { useReducedMotion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import BloubHome, { type BloubState } from './BloubHome';

const BLOUB_EVENT = 'levonis:bloub-state';

export function signalBloub(state: BloubState, durationMs = 650): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BLOUB_EVENT, { detail: { state, durationMs } }));
}

type Frame = { x: number; y: number; size: number };

function centerFrame(): Frame {
  if (typeof window === 'undefined') return { x: 0, y: 0, size: 88 };
  const size = Math.min(96, Math.max(78, window.innerWidth * 0.23));
  return { x: (window.innerWidth - size) / 2, y: (window.innerHeight - size) / 2, size };
}

export function measureHomeTarget(root: ParentNode = document): Frame | null {
  const target = root.querySelector<HTMLElement>('[data-bloub-home-target]');
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const size = Math.min(rect.width, rect.height);
  return {
    x: rect.left + (rect.width - size) / 2,
    y: rect.top + (rect.height - size) / 2,
    size,
  };
}

/**
 * One DOM node owns both the bootstrap character and the navigation character.
 * Moving its measured fixed-position frame creates a real shared-element
 * transition; there is never a centre copy fading into a separate nav copy.
 */
export default function AppIntro({ ready }: { ready: boolean }) {
  const location = useLocation();
  const { loc } = useLanguage();
  const reduced = !!useReducedMotion();
  const [frame, setFrame] = React.useState<Frame>(centerFrame);
  const [phase, setPhase] = React.useState<'loading' | 'travelling' | 'docked' | 'hidden'>('loading');
  const [state, setState] = React.useState<BloubState>('thinking');
  const [pageVisible, setPageVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden);
  const completedRef = React.useRef(false);
  const stateTimerRef = React.useRef<number | null>(null);
  const previousPathRef = React.useRef(location.pathname);

  const moveToCurrentTarget = React.useCallback(
    (allowTravel: boolean) => {
      const target = measureHomeTarget();
      if (!target) {
        setPhase('hidden');
        return false;
      }
      setFrame(target);
      setPhase(allowTravel && !reduced ? 'travelling' : 'docked');
      return true;
    },
    [reduced]
  );

  React.useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: BloubState; durationMs?: number }>).detail;
      if (!detail?.state) return;
      if (stateTimerRef.current != null) window.clearTimeout(stateTimerRef.current);
      setState(detail.state);
      if (detail.state !== 'idle') {
        stateTimerRef.current = window.setTimeout(() => setState('idle'), Math.max(180, detail.durationMs ?? 650));
      }
    };
    window.addEventListener(BLOUB_EVENT, onState);
    return () => {
      window.removeEventListener(BLOUB_EVENT, onState);
      if (stateTimerRef.current != null) window.clearTimeout(stateTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  React.useEffect(() => {
    if (!ready || completedRef.current) return;
    let frameId = 0;
    let attempts = 0;
    const finishBootstrap = () => {
      attempts += 1;
      const target = measureHomeTarget();
      // BottomNav and this sibling can commit on adjacent frames. A missing
      // first measurement is not proof that the route has no Home target.
      if (!target && attempts < 5) {
        frameId = window.requestAnimationFrame(finishBootstrap);
        return;
      }
      completedRef.current = true;
      if (!target) {
        setPhase('hidden');
        setState('idle');
        return;
      }
      setFrame(target);
      setPhase(reduced ? 'docked' : 'travelling');
      setState('navigation');
    };
    frameId = window.requestAnimationFrame(finishBootstrap);
    return () => window.cancelAnimationFrame(frameId);
  }, [ready, reduced]);

  React.useEffect(() => {
    if (!completedRef.current || previousPathRef.current === location.pathname) return;
    previousPathRef.current = location.pathname;
    setState('navigation');
    const frameId = window.requestAnimationFrame(() => {
      moveToCurrentTarget(false);
      stateTimerRef.current = window.setTimeout(() => setState('idle'), 420);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [location.pathname, moveToCurrentTarget]);

  React.useEffect(() => {
    if (!completedRef.current) return;
    let frameId = 0;
    const update = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => moveToCurrentTarget(false));
    };
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [moveToCurrentTarget]);

  const finishTravel = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform' || phase !== 'travelling') return;
    setPhase('docked');
    setState('idle');
  };

  return (
    <div
      className="lv-app-intro"
      data-phase={phase}
      data-reduced-motion={reduced ? 'true' : 'false'}
      data-page-visible={pageVisible ? 'true' : 'false'}
      data-bloub-rendered={phase === 'hidden' ? 'false' : 'true'}
      aria-live="polite"
      aria-busy={phase === 'loading'}
    >
      <div className="lv-app-intro__veil" aria-hidden="true" />
      <div
        className="lv-app-intro__character"
        style={{
          width: frame.size,
          height: frame.size,
          transform: `translate3d(${frame.x}px, ${frame.y}px, 0)`,
        }}
        onTransitionEnd={finishTravel}
      >
        <BloubHome state={pageVisible ? state : 'idle'} className="h-full w-full" />
      </div>
      {phase === 'loading' ? (
        <span className="sr-only">{loc('جارٍ تجهيز Levonis…', 'Preparing Levonis…', 'Levonis ئامادە دەکرێت…')}</span>
      ) : null}
    </div>
  );
}
