import React, { useEffect, useRef } from 'react';

/**
 * AuthBackground — the manufacturing scene behind /auth.
 *
 * Four layers, all decorative (aria-hidden, pointer-events none), all
 * animated with transform/opacity only:
 *
 *   1. two pre-blurred light pools (gold + filament green)
 *   2. a build-plate grid with a brighter major line every 5th cell
 *   3. THE SIGNATURE: an isometric wireframe "L" — the LEVONIS mark —
 *      printed layer by layer on a 16s cycle, with a toolhead tracking the
 *      active layer and a machine readout (Z height / layer counter) that
 *      follows the same clock
 *   4. a few slow-rising filament motes
 *
 * Under prefers-reduced-motion the CSS collapses everything to a finished
 * static frame (auth.css) and this component freezes the readout to match.
 * The readout is written straight into a ref'd node — zero React re-renders.
 */

/** One print cycle in ms — must match the 16s animations in auth.css. */
const CYCLE_MS = 16000;
/** Fraction of the cycle spent building — must match the 72% keyframe. */
const BUILD_END = 0.72;
const TOTAL_LAYERS = 168;
const MAX_Z_MM = 23.5;

/* Isometric wireframe of the extruded "L", pre-sliced into print layers.
   Generated from the footprint (0,0)(3,0)(3,1.15)(1.15,1.15)(1.15,3.2)(0,3.2)
   extruded to h=2.35 and projected at 30°. */
const SLICES = [
  'M170.1 148.2L305.2 226.2L253.4 256.1L170.1 208.0L77.8 261.3L26.0 231.4Z',
  'M170.1 138.8L305.2 216.8L253.4 246.7L170.1 198.6L77.8 251.9L26.0 222.0Z',
  'M170.1 129.4L305.2 207.4L253.4 237.3L170.1 189.2L77.8 242.5L26.0 212.6Z',
  'M170.1 120.0L305.2 198.0L253.4 227.9L170.1 179.8L77.8 233.1L26.0 203.2Z',
  'M170.1 110.6L305.2 188.6L253.4 218.5L170.1 170.4L77.8 223.7L26.0 193.8Z',
  'M170.1 101.2L305.2 179.2L253.4 209.1L170.1 161.0L77.8 214.3L26.0 184.4Z',
  'M170.1 91.8L305.2 169.8L253.4 199.7L170.1 151.6L77.8 204.9L26.0 175.0Z',
  'M170.1 82.4L305.2 160.4L253.4 190.3L170.1 142.2L77.8 195.5L26.0 165.6Z',
  'M170.1 73.0L305.2 151.0L253.4 180.9L170.1 132.8L77.8 186.1L26.0 156.2Z',
  'M170.1 63.6L305.2 141.6L253.4 171.5L170.1 123.4L77.8 176.7L26.0 146.8Z',
  'M170.1 54.2L305.2 132.2L253.4 162.1L170.1 114.0L77.8 167.3L26.0 137.4Z',
  'M170.1 44.8L305.2 122.8L253.4 152.7L170.1 104.6L77.8 157.9L26.0 128.0Z',
  'M170.1 35.4L305.2 113.4L253.4 143.3L170.1 95.2L77.8 148.5L26.0 118.6Z',
  'M170.1 26.0L305.2 104.0L253.4 133.9L170.1 85.8L77.8 139.1L26.0 109.2Z',
];
const EDGES = [
  'M170.1 148.2L170.1 26.0',
  'M305.2 226.2L305.2 104.0',
  'M253.4 256.1L253.4 133.9',
  'M170.1 208.0L170.1 85.8',
  'M77.8 261.3L77.8 139.1',
  'M26.0 231.4L26.0 109.2',
];

/* Filament motes: deterministic placements, no per-render randomness. */
const MOTES: Array<{ x: string; s: string; t: string; d: string; c: string; o: number; wx: string }> = [
  { x: '8%', s: '2px', t: '21s', d: '0s', c: 'rgba(216,192,138,0.8)', o: 0.3, wx: '10px' },
  { x: '16%', s: '3px', t: '26s', d: '-9s', c: 'rgba(250,250,247,0.6)', o: 0.16, wx: '-14px' },
  { x: '27%', s: '2px', t: '18s', d: '-4s', c: 'rgba(216,192,138,0.7)', o: 0.26, wx: '6px' },
  { x: '38%', s: '2px', t: '24s', d: '-13s', c: 'rgba(126,143,79,0.8)', o: 0.24, wx: '-8px' },
  { x: '52%', s: '3px', t: '28s', d: '-6s', c: 'rgba(216,192,138,0.55)', o: 0.18, wx: '12px' },
  { x: '61%', s: '2px', t: '19s', d: '-15s', c: 'rgba(250,250,247,0.55)', o: 0.2, wx: '-6px' },
  { x: '70%', s: '2px', t: '23s', d: '-2s', c: 'rgba(216,192,138,0.75)', o: 0.28, wx: '9px' },
  { x: '79%', s: '3px', t: '27s', d: '-11s', c: 'rgba(126,143,79,0.7)', o: 0.2, wx: '-10px' },
  { x: '87%', s: '2px', t: '20s', d: '-7s', c: 'rgba(216,192,138,0.65)', o: 0.24, wx: '7px' },
  { x: '94%', s: '2px', t: '25s', d: '-17s', c: 'rgba(250,250,247,0.5)', o: 0.15, wx: '-12px' },
  { x: '45%', s: '2px', t: '22s', d: '-19s', c: 'rgba(216,192,138,0.6)', o: 0.2, wx: '5px' },
  { x: '33%', s: '2px', t: '29s', d: '-1s', c: 'rgba(250,250,247,0.5)', o: 0.14, wx: '-5px' },
];

export interface AuthBackgroundProps {
  /** Mirror of useReducedMotion() so the readout freezes with the CSS. */
  reduced: boolean;
}

export default function AuthBackground({ reduced }: AuthBackgroundProps) {
  const hudRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = hudRef.current;
    if (!node) return;
    const write = (z: number, n: number) => {
      node.innerHTML = `<b>Z</b> ${z.toFixed(2).padStart(5, '0')}&thinsp;mm&ensp;·&ensp;<b>N</b> ${String(n).padStart(3, '0')}/${TOTAL_LAYERS}`;
    };
    if (reduced) {
      // The CSS shows the finished part; the readout agrees.
      write(MAX_Z_MM, TOTAL_LAYERS);
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      // Same clock as the CSS cycle: build for the first 72%, then hold.
      const p = ((Date.now() - t0) % CYCLE_MS) / CYCLE_MS;
      const b = Math.min(p / BUILD_END, 1);
      write(b * MAX_Z_MM, Math.max(1, Math.round(b * TOTAL_LAYERS)));
    };
    tick();
    const id = window.setInterval(tick, 150);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <div className="lv-bg" aria-hidden>
      <div className="lv-bg__glow" />
      <div className="lv-bg__gridwrap">
        <div className="lv-bg__grid" />
      </div>

      {/* The part being manufactured behind the interface. */}
      <div className="lv-print">
        <span className="lv-print__tick lv-print__tick--tl" />
        <span className="lv-print__tick lv-print__tick--tr" />
        <span className="lv-print__tick lv-print__tick--bl" />
        <span className="lv-print__tick lv-print__tick--br" />
        <svg viewBox="0 0 332 288" fill="none" className="block h-auto w-full">
          <defs>
            <mask id="lv-build-mask">
              {/* Grows bottom-up over the build phase of the cycle. */}
              <rect className="lv-print__mask-rect" x="0" y="0" width="332" height="288" fill="#fff" />
            </mask>
          </defs>
          <g className="lv-print__cycle">
            <g mask="url(#lv-build-mask)">
              {SLICES.map((d, i) => (
                <path
                  key={d}
                  d={d}
                  stroke={
                    i === SLICES.length - 1
                      ? 'rgba(216,192,138,0.6)'
                      : i % 5 === 0
                        ? 'rgba(216,192,138,0.4)'
                        : 'rgba(216,192,138,0.22)'
                  }
                  strokeWidth={i === SLICES.length - 1 ? 1.4 : 1}
                />
              ))}
              {EDGES.map((d) => (
                <path key={d} d={d} stroke="rgba(250,250,247,0.10)" strokeWidth="1" />
              ))}
            </g>
            {/* Toolhead: rides the active layer, oscillates across it. */}
            <g className="lv-print__head">
              <g className="lv-print__head-x">
                <g transform="translate(166 261)">
                  <circle r="7" fill="rgba(216,192,138,0.18)" />
                  <circle r="2.2" fill="#D8C08A" />
                  <path d="M-11 0H-5M5 0H11M0 -11V-5M0 5V11" stroke="rgba(216,192,138,0.5)" strokeWidth="1" />
                </g>
              </g>
            </g>
          </g>
        </svg>
        <span ref={hudRef} className="lv-print__hud lv-mono" />
      </div>

      <div className="lv-bg__dots">
        {MOTES.map((m, i) => (
          <span
            key={i}
            style={
              {
                '--x': m.x,
                '--s': m.s,
                '--t': m.t,
                '--d': m.d,
                '--c': m.c,
                '--o': m.o,
                '--wx': m.wx,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
