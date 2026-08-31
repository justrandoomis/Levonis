import React, { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import AuthBackground from './AuthBackground';
import AuthBrand from './AuthBrand';
import AuthCard from './AuthCard';
import './auth.css';

/**
 * AuthShell — the /auth stage: near-black ground, the manufacturing scene
 * behind, one centered column with the brand and the machined card.
 *
 * Owns three page-level behaviours so the screens don't have to:
 *  - safe-area padding + its own scroll region (the app shell around
 *    full-screen routes is overflow-hidden)
 *  - the load choreography: brand settles first, then the card rises
 *  - pointer parallax on desktop (pointer: fine) — two CSS custom
 *    properties written per animation frame; every layer in
 *    AuthBackground derives its own depth from them. Disabled under
 *    prefers-reduced-motion and never active on touch screens.
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
    <div ref={rootRef} dir={dir} className="lv-auth relative min-h-0 w-full flex-1 overflow-hidden font-sans text-white">
      <AuthBackground reduced={reduced} />
      <div className="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex min-h-full w-full max-w-[26rem] flex-col px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="m-auto w-full py-3">
            <motion.div
              initial={{ opacity: 0, y: reduced ? 0 : -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <AuthBrand />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: reduced ? 0 : 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0 : 0.5, delay: reduced ? 0 : 0.08, ease: [0.22, 1, 0.36, 1] }}
            >
              <AuthCard>{children}</AuthCard>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
