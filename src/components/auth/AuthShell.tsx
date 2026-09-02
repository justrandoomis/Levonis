import React, { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import AuthBackground from './AuthBackground';
import AuthBrand from './AuthBrand';
import AuthCard from './AuthCard';
import './auth.css';

/**
 * AuthShell — the /auth stage: the CAD viewport behind, one centered column
 * with the brand row (wordmark + language switch) and the panel.
 *
 * Owns the page-level behaviours so the screens don't have to:
 *  - safe-area padding + its own scroll region (the app shell around
 *    full-screen routes is overflow-hidden), CTAs stay in-flow so the
 *    software keyboard scrolls to them instead of covering them
 *  - the entrance: brand, then the panel, opacity + 8px — CSS only
 *  - a slow pointer parallax on fine pointers: two custom properties
 *    written per frame, every background layer eases toward them over
 *    ~1.2s (auth.css). Off under prefers-reduced-motion, never on touch.
 */
export default function AuthShell({ dir, children }: { dir: 'ltr' | 'rtl'; children: React.ReactNode }) {
  const reduced = !!useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reduced) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const onMove = (e: PointerEvent) => {
      x = (e.clientX / window.innerWidth - 0.5) * 2;
      y = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!raf) {
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          root.style.setProperty('--plx-x', x.toFixed(3));
          root.style.setProperty('--plx-y', y.toFixed(3));
        });
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return (
    <div ref={rootRef} dir={dir} className="lv-auth relative min-h-0 w-full flex-1 overflow-hidden font-sans">
      <AuthBackground />
      <div className="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex min-h-full w-full max-w-[26rem] flex-col px-3 pt-[max(1.125rem,env(safe-area-inset-top))] pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] min-[360px]:px-4">
          <div className="m-auto w-full py-2">
            <div className="lv-brand lv-enter">
              <AuthBrand />
              <LanguageSwitch />
            </div>
            <div className="lv-enter lv-enter--2">
              <AuthCard>{children}</AuthCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** AR / EN / KU — the page has no header, so the switch lives in the brand row. */
function LanguageSwitch() {
  const { lang, setLang } = useLanguage();
  const options: Array<['ar' | 'en' | 'ckb', string, string]> = [
    ['ar', 'AR', 'العربية'],
    ['en', 'EN', 'English'],
    ['ckb', 'KU', 'کوردی'],
  ];
  return (
    <div className="lv-lang lv-mono" role="group" aria-label="Language">
      {options.map(([code, short, name]) => (
        <button
          key={code}
          type="button"
          className="lv-lang__btn"
          aria-pressed={lang === code}
          aria-label={name}
          lang={code === 'ckb' ? 'ckb' : code}
          onClick={() => setLang(code)}
        >
          {short}
        </button>
      ))}
    </div>
  );
}
