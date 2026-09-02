import React from 'react';
import printerSvg from './blueprint/printer.svg?raw';
import spoolSvg from './blueprint/spool.svg?raw';
import hotendSvg from './blueprint/hotend.svg?raw';
import partsSvg from './blueprint/parts.svg?raw';
import triadSvg from './blueprint/triad.svg?raw';

/**
 * AuthBackground — the CAD viewport behind /auth.
 *
 * Stroke-only line drawings of the machine (an isometric printer, a spool,
 * a hotend section, a parts strip) on a drafting grid, with tiny mono
 * dimension notes and the viewport's HUD chrome (a triad, a readout, a
 * title block). Everything is decorative (aria-hidden, pointer-events
 * none) and placed by auth.css per breakpoint: phones get the printer only,
 * tablets add the hotend, desktops the full composition.
 *
 * The drawings are static SVG files (stroke="currentColor", non-scaling
 * strokes) inlined at build time, so the CSS colour tokens tint them and
 * a note can be anchored to a point of the drawing in its own viewBox
 * units. The only motion is a bead settling on the nozzle every 20s, the
 * spool breathing over 24s and one dimension line drawing itself over 18s;
 * all three collapse to a finished frame under prefers-reduced-motion.
 */

type ViewBox = [number, number, number, number];
const VB = {
  printer: [-321.8, -377.6, 591.6, 717.6] as ViewBox,
  spool: [-87.9, -124.9, 272.9, 312] as ViewBox,
  hotend: [-28, -20, 56, 110] as ViewBox,
  parts: [-42, -42, 406, 84] as ViewBox,
  triad: [-41.2, -46, 156.8, 92] as ViewBox,
};

type Anchor = 'c' | 'w' | 'e' | 'n' | 's';
const ANCHOR_TRANSFORM: Record<Anchor, string> = {
  c: 'translate(-50%, -50%)',
  w: 'translate(0, -50%)',
  e: 'translate(-100%, -50%)',
  n: 'translate(-50%, 0)',
  s: 'translate(-50%, -100%)',
};

/** Position a note at a point of the drawing, in the drawing's viewBox units. */
function at([vx, vy, vw, vh]: ViewBox, x: number, y: number, anchor: Anchor = 'c'): React.CSSProperties {
  return {
    left: `${(((x - vx) / vw) * 100).toFixed(2)}%`,
    top: `${(((y - vy) / vh) * 100).toFixed(2)}%`,
    transform: ANCHOR_TRANSFORM[anchor],
  };
}

function Note({
  vb, x, y, anchor, live, sm, callout, red, children,
}: {
  vb: ViewBox; x: number; y: number; anchor?: Anchor; live?: boolean; sm?: boolean; callout?: boolean; red?: boolean; children: React.ReactNode;
}) {
  return (
    <span
      className={`lv-note${live ? ' lv-note--live' : ''}${sm ? ' lv-note--sm' : ''}${callout ? ' lv-note--callout' : ''}${red ? ' lv-note--red' : ''}`}
      style={at(vb, x, y, anchor)}
    >
      {children}
    </span>
  );
}

/* The SVG files are repository assets, not user content. */
const Drawing = ({ svg }: { svg: string }) => <span className="lv-cad__art" dangerouslySetInnerHTML={{ __html: svg }} />;

export default function AuthBackground() {
  return (
    <div className="lv-bg" aria-hidden>
      <div className="lv-bg__gridwrap">
        <div className="lv-bg__grid" />
      </div>

      <div className="lv-bg__scene">
        {/* The printer: isometric wireframe; live dimensions in gold. */}
        <figure className="lv-cad lv-cad--printer">
          <Drawing svg={printerSvg} />
          <svg
            className="lv-cad__leaders"
            viewBox={VB.printer.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            opacity="0.7"
          >
            <g vectorEffect="non-scaling-stroke">
              <path d="M-21.7 92.5L70 152H150" />
              <circle cx="-21.7" cy="92.5" r="2.2" />
              <path d="M-52 -270L-140 -330H-220" />
              <circle cx="-52" cy="-270" r="2.2" />
              {/* the one red detail: the bed's Y dimension, drawing itself */}
              <path className="lv-draw" pathLength={1} d="M-300 190L-40 340" stroke="#a4443a" opacity="0.7" />
            </g>
          </svg>
          <span className="lv-bead" style={at(VB.printer, -21.7, 92.5)} />
          <Note vb={VB.printer} x={-164} y={199} live>220 × 220</Note>
          <Note vb={VB.printer} x={-6} y={115} anchor="w" live>Z 114.00</Note>
          <Note vb={VB.printer} x={-209} y={-103} anchor="e">380</Note>
          <Note vb={VB.printer} x={154} y={152} anchor="w" callout>HOTEND · Ø0.4</Note>
          <Note vb={VB.printer} x={-224} y={-330} anchor="e" callout>SPOOL · PLA 1 kg</Note>
        </figure>

        {/* Spool, top-start, cropped by the viewport edge. */}
        <figure className="lv-cad lv-cad--spool">
          <Drawing svg={spoolSvg} />
          <Note vb={VB.spool} x={125} y={85} anchor="w" live>Ø1.75</Note>
          <Note vb={VB.spool} x={171} y={32} anchor="w">Ø200</Note>
        </figure>

        {/* Hotend cross-section, top-end. */}
        <figure className="lv-cad lv-cad--hotend">
          <Drawing svg={hotendSvg} />
          <Note vb={VB.hotend} x={17.5} y={-12} anchor="w" live>Ø1.75</Note>
          <Note vb={VB.hotend} x={18.5} y={86} anchor="w" live>Ø0.4</Note>
          <Note vb={VB.hotend} x={-27} y={60} anchor="e">A</Note>
          <Note vb={VB.hotend} x={27} y={60} anchor="w">A</Note>
          <Note vb={VB.hotend} x={17} y={72} anchor="w" red>±0.05</Note>
          <Note vb={VB.hotend} x={0} y={93} anchor="n">SECTION A-A · 2:1</Note>
        </figure>

        {/* Parts strip, bottom-end. */}
        <figure className="lv-cad lv-cad--parts">
          <Drawing svg={partsSvg} />
          <Note vb={VB.parts} x={0} y={46} anchor="n" sm>GEAR m3 · z18</Note>
          <Note vb={VB.parts} x={92} y={46} anchor="n" sm>608ZZ</Note>
          <Note vb={VB.parts} x={190} y={46} anchor="n" sm>GT2 · 20T</Note>
          <Note vb={VB.parts} x={295} y={46} anchor="n" sm>T8 · LEAD 8</Note>
          <Note vb={VB.parts} x={320} y={-18} anchor="s" sm>8.00</Note>
        </figure>
      </div>

      {/* HUD chrome in the corners: placement mirrors in RTL, content is LTR. */}
      <div className="lv-hud lv-hud--tl lv-mono">
        VIEW · ISOMETRIC
        <br />
        GRID 24 / 120 · SCALE 1:4
      </div>
      <div className="lv-hud lv-hud--tr">
        <figure className="lv-cad" style={{ position: 'relative', ['--o' as string]: 1 }}>
          <Drawing svg={triadSvg} />
          <Note vb={VB.triad} x={109} y={33} anchor="w" sm>X</Note>
          <Note vb={VB.triad} x={50} y={33} anchor="e" sm>Y</Note>
          <Note vb={VB.triad} x={79.7} y={-19} anchor="s" sm>Z</Note>
        </figure>
      </div>
      <div className="lv-hud lv-hud--bl lv-mono">
        <span className="lv-hud__sub">VIEW ISO · GRID 24 / 120 · SCALE 1:4</span>
        X 150.00 &nbsp; Y 174.00 &nbsp; <b>Z 114.00</b>
      </div>
      <div className="lv-hud lv-hud--br lv-mono">
        <table className="lv-tb">
          <tbody>
            <tr><td>DWG</td><td>LV-AUTH-01</td><td>REV</td><td>C</td></tr>
            <tr><td>SHEET</td><td>1 / 1</td><td>UNITS</td><td>mm · ±0.05</td></tr>
          </tbody>
        </table>
        <figure className="lv-cad lv-cad--mini" style={{ position: 'relative', ['--o' as string]: 1 }}>
          <Drawing svg={triadSvg} />
        </figure>
      </div>
    </div>
  );
}
