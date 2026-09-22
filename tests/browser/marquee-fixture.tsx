/**
 * Local fixture for the home belts. The PRODUCTION <Marquee> is mounted — this
 * file supplies only content and a direction switch, so what the browser proof
 * measures is the shipped component and not a copy of it.
 *
 * Two belts, matching the two real call sites: the ads strip passes plain
 * `children` (text), the brands belt passes `renderSet` (fixed-size boxes).
 * Both shapes have to drift, because a zero-width measurement in either one
 * used to leave the loop permanently un-started.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import Marquee from '../../src/components/home/Marquee';
import '../../src/index.css';

/**
 * The component reads `dir` from the language context only to know when to
 * RE-MEASURE. The direction that actually decides the scroll convention is the
 * container's own computed one, which `<html dir>` below sets — that is the
 * whole point of reading it from `getComputedStyle` rather than from the app
 * language, and the LTR case below proves the two can disagree without
 * breaking the belt.
 */

function Fixture() {
  return (
    <div style={{ background: '#000', minHeight: '100vh', padding: '8px 0' }}>

      {/* The ads strip: plain children, text content. */}
      <div data-belt="ads">
        <Marquee speed={42}>
          <div className="flex items-center gap-3 pe-3">
            {['عرض اليوم', 'شحن مجاني', 'قطع أصلية', 'ضمان سنة', 'تقسيط'].map((t) => (
              <span key={t} className="text-white text-sm whitespace-nowrap px-3 py-2">
                {t}
              </span>
            ))}
          </div>
        </Marquee>
      </div>

      {/* The brands belt: renderSet, fixed-size marks, links inside — the
          shape whose tap used to latch the belt off for good. */}
      <div data-belt="brands" style={{ marginTop: 12 }}>
        <Marquee speed={34} renderSet={brandSet} />
      </div>

      {/*
        THE SAME BELT, LEFT TO RIGHT, in the same document as the RTL ones.

        Not a toggle: the direction that decides the scroll convention is the
        CONTAINER's computed one, so an LTR wrapper inside an RTL page is a
        genuine LTR belt with no flip to wait for. It is here because the
        implementation this replaces derived its sign from the UI LANGUAGE and
        asserted that RTL `scrollLeft` is always negative — while
        src/lib/useRail.ts in this same repository had already measured three
        incompatible conventions. On the wrong one the belt drives into a clamp
        and dies, and nothing in the old suite would have noticed.
      */}
      <div data-belt="ltr" dir="ltr" style={{ marginTop: 12 }}>
        <Marquee speed={34} renderSet={brandSet} />
      </div>
    </div>
  );
}

function brandSet(first: boolean) {
  return (
    <div className="flex items-center gap-3 pe-3">
      {['bambu', 'creality', 'prusa', 'anycubic', 'elegoo'].map((b) => (
        <a
          key={b}
          href="#!"
          {...(first ? { 'data-mark': b } : { tabIndex: -1 })}
          className="w-[112px] h-14 shrink-0 rounded-xl bg-zinc-800 text-white text-xs flex items-center justify-center"
        >
          {b}
        </a>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <Fixture />
  </LanguageProvider>
);
