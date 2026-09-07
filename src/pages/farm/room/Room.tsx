/**
 * THE PRINT ROOM — one inline SVG, no canvas, no WebGL.
 *
 * Floor tiles come from the location's `max_printers`; every occupied slot
 * draws the SAME `<symbol id="fp">` printer once via `<use>`, coloured by its
 * state through `currentColor` and tinted for health through a CSS variable
 * (custom properties inherit across the `<use>` shadow boundary — descendant
 * selectors do not, which is why every per-machine difference travels as a
 * variable or as `color`). A printing machine animates exactly two things,
 * both compositor-only: the bed plate translates and the LED strip breathes.
 * Both stop under `prefers-reduced-motion` and pause when the tab is hidden
 * (`--fp-play`). Idle machines cost nothing per frame.
 *
 * Names, countdowns and the hit targets are HTML laid over the drawing by
 * percent, so Cairo shapes the Arabic and every button is a real 44px control
 * that a Sheet can anchor to. The drawing never decides anything: a countdown
 * reaching zero is the caller's cue to ask the server.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { FarmPrinter, FarmSpool, PublicFarmConfig } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { colorSwatch, countdown, ms, printerName } from '../format';
import { HEALTH_HEX, STATE_TEXT, healthTone } from '../ui';
import { at, iso, pts, roomLayout, type Pt } from './iso';

// ------------------------------------------------------ the printer symbol
//
// A BEDSLINGER in a few strokes — the silhouette of the starter machine, not a
// generic gantry: a flat base carrying a rectangular bed that runs front to
// back, ONE vertical column at the back on the machine's left, a horizontal
// X-beam cantilevered from it across the bed, a small toolhead block under
// the beam, the spool on a holder beside the column, and an LED strip along
// the front edge. Every part is a path (35 commands in all) or a circle in the
// room's own projection. `currentColor` carries the state — the bed outline,
// the nozzle and the LED — and `--fp-health` the health strip.

const A = 0.33; // half footprint, world units
const H = 6; // base height, px
const Z = 46; // column height, px
const B = 0.2; // bed half size
const CX = A - 0.08; // the column stands at the back, on the machine's left (+x)
const CY = -A + 0.07; // …on the back edge

const P = (x: number, y: number, z = 0): Pt => iso(x, y, z);
/** Path data from projected points: M, L…, and Z when closed. */
const path = (points: Pt[], close = true): string =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + (close ? ' Z' : '');

const BASE_TOP = path([P(-A, -A, H), P(A, -A, H), P(A, A, H), P(-A, A, H)]);
const BASE_LEFT = path([P(-A, A, 0), P(A, A, 0), P(A, A, H), P(-A, A, H)]);
const BASE_RIGHT = path([P(A, -A, 0), P(A, A, 0), P(A, A, H), P(A, -A, H)]);
const BED = path([P(-B, -B + 0.04, H + 1.5), P(B, -B + 0.04, H + 1.5), P(B, B + 0.04, H + 1.5), P(-B, B + 0.04, H + 1.5)]);
const COLUMN = path([P(CX, CY, H), P(CX, CY, Z)], false);
const BEAM = path([P(CX, CY, Z - 8), P(-A + 0.03, CY, Z - 8)], false);
const HEAD = path([P(-0.1, CY + 0.02, Z - 8.5), P(0.04, CY + 0.02, Z - 8.5), P(0.04, CY + 0.02, Z - 17), P(-0.1, CY + 0.02, Z - 17)]);
const NOZZLE = P(-0.03, CY + 0.06, Z - 18);
const HOLDER = path([P(CX, CY, Z - 4), P(CX + 0.2, CY, Z - 4)], false);
const SPOOL = P(CX + 0.26, CY, Z - 4);
const LED = path([P(-A + 0.05, A, 2.6), P(A - 0.05, A, 2.6)], false);
const HEALTH = path([P(A, A - 0.24, 2.6), P(A, A - 0.06, 2.6)], false);

const CSS = `
@keyframes fp-bed { from { transform: translate(0, 0); } to { transform: translate(-6.4px, 3.2px); } }
@keyframes fp-led { from { opacity: 0.3; } to { opacity: 1; } }
.fp-bed { animation: var(--fp-bed-anim, none); animation-play-state: var(--fp-play, running); }
.fp-led { animation: var(--fp-led-anim, none); animation-play-state: var(--fp-play, running); }
.fp-printing { --fp-bed-anim: fp-bed 2.6s ease-in-out infinite alternate; --fp-led-anim: fp-led 1.3s ease-in-out infinite alternate; }
@media (prefers-reduced-motion: reduce) { .fp-printing { --fp-bed-anim: none; --fp-led-anim: none; } }
.fp-health { stroke: var(--fp-health, #52525b); }
`;

function PrinterSymbol() {
  return (
    <symbol id="fp" overflow="visible" data-farm-printer-symbol>
      {/* base: a flat box */}
      <path d={BASE_LEFT} fill="#1c1c20" stroke="#4b4b53" strokeWidth="1" strokeLinejoin="round" />
      <path d={BASE_RIGHT} fill="#232327" stroke="#4b4b53" strokeWidth="1" strokeLinejoin="round" />
      <path d={BASE_TOP} fill="#2a2a2f" stroke="#55555d" strokeWidth="1" strokeLinejoin="round" />
      {/* the LED strip along the front edge — the second animated part — and the health strip on the side */}
      <path className="fp-led" d={LED} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path className="fp-health" d={HEALTH} strokeWidth="2.2" strokeLinecap="round" />
      {/* bed plate — the first of the two animated parts; it runs front to back */}
      <path className="fp-bed" d={BED} fill="#18181b" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.9" strokeLinejoin="round" />
      {/* one column, one beam */}
      <path d={COLUMN} stroke="#6b6b75" strokeWidth="3" strokeLinecap="round" />
      <path d={BEAM} stroke="#5f5f68" strokeWidth="2.4" strokeLinecap="round" />
      {/* spool holder and spool, beside the column */}
      <path d={HOLDER} stroke="#5f5f68" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx={SPOOL.x} cy={SPOOL.y} r="6.2" fill="#3a3a40" stroke="#5b5b64" strokeWidth="1" />
      <circle cx={SPOOL.x} cy={SPOOL.y} r="1.8" fill="#0a0a0a" />
      {/* toolhead under the beam, nozzle in the state colour */}
      <path d={HEAD} fill="#3f3f46" stroke="#5b5b64" strokeWidth="0.8" strokeLinejoin="round" />
      <circle cx={NOZZLE.x} cy={NOZZLE.y} r="1.2" fill="currentColor" />
    </symbol>
  );
}

// ---------------------------------------------------------------- the room

export interface RoomProps {
  printers: FarmPrinter[];
  spools: FarmSpool[];
  /** For the model names behind a nameless machine (see `printerName`). */
  config: PublicFarmConfig;
  maxPrinters: number;
  /** Estimated server time (ms). */
  now: number;
  lang: string;
  s: FarmStrings;
  onOpenPrinter: (printer: FarmPrinter, anchor: HTMLElement | null) => void;
  onOpenEmptySlot: (slot: number, anchor: HTMLElement | null) => void;
}

/** What the label under a machine says on its second line. */
function machineLine(p: FarmPrinter, now: number, s: FarmStrings, lang: string): string {
  if (p.state === 'printing' && p.current) {
    const end = ms(p.current.ends_at);
    return end === null ? s.statePrinting : countdown(end - now, lang);
  }
  if (p.state === 'maintenance' && p.state_until) {
    const end = ms(p.state_until);
    return end === null ? s.stateMaintenance : countdown(end - now, lang);
  }
  if (p.state === 'done') return s.stateDone;
  if (p.state === 'broken') return s.stateBroken;
  return s.stateIdle;
}

export default function Room({ printers, spools, config, maxPrinters, now, lang, s, onOpenPrinter, onOpenEmptySlot }: RoomProps) {
  const layout = useMemo(() => roomLayout(maxPrinters), [maxPrinters]);
  const vb = layout.viewBox;
  const titleId = useId();
  const descId = useId();
  const gradId = useId();

  // Pause the two loops while the tab is hidden — nothing should draw for a
  // screen nobody is looking at.
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'visible');
  useEffect(() => {
    const onVis = () => setPaused(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const bySlot = useMemo(() => {
    const m = new Map<number, FarmPrinter>();
    for (const p of printers) m.set(p.slot, p);
    return m;
  }, [printers]);

  const anyPrinting = printers.some((p) => p.state === 'printing');
  const shelfSpools = spools.slice(0, layout.shelf.spoolAnchors.length);
  const extraSpools = spools.length - shelfSpools.length;

  const hitW = `max(44px, ${((48 / vb.w) * 100).toFixed(2)}%)`;
  const hitH = `max(44px, ${((72 / vb.h) * 100).toFixed(2)}%)`;

  return (
    <div className="relative w-full select-none" data-farm-room>
      <style>{CSS}</style>
      <svg
        viewBox={`${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`}
        className="block w-full h-auto text-zinc-500"
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        style={{ ['--fp-play' as string]: paused || !anyPrinting ? 'paused' : 'running' }}
      >
        <title id={titleId}>{s.roomLabel}</title>
        <desc id={descId}>{s.roomDesc(printers.length, maxPrinters)}</desc>
        <defs>
          <PrinterSymbol />
          {/* The one gradient in the game: light falling across the floor from the back-left. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.07" />
            <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.28" />
          </linearGradient>
        </defs>

        {/* walls — low, so the floor and the machines carry the picture */}
        <polygon points={pts(layout.wallLeft)} fill="#0d0d0f" stroke="#26262b" strokeWidth="1" />
        <polygon points={pts(layout.wallRight)} fill="#111113" stroke="#26262b" strokeWidth="1" />
        <polyline points={pts(layout.skirting)} fill="none" stroke="#2c2c32" strokeWidth="1.2" />

        {/* floor: the furniture row plus every printer tile */}
        <g>
          {Array.from({ length: layout.cols }, (_, col) => (
            <polygon
              key={`back-${col}`}
              points={pts([iso(col, 0), iso(col + 1, 0), iso(col + 1, 1), iso(col, 1)])}
              fill={col % 2 === 0 ? '#141416' : '#16161a'}
              stroke="#222226"
              strokeWidth="0.8"
            />
          ))}
          {layout.tiles.map((t) => {
            const p = bySlot.get(t.slot);
            const printing = p?.state === 'printing';
            return (
              <polygon
                key={`tile-${t.slot}`}
                points={pts(t.corners)}
                fill={(t.col + t.row) % 2 === 0 ? '#141416' : '#16161a'}
                stroke={printing ? '#BAA369' : '#222226'}
                strokeOpacity={printing ? 0.45 : 1}
                strokeWidth={printing ? 1.2 : 0.8}
              />
            );
          })}
          <polygon
            points={pts([iso(0, 0), iso(layout.cols, 0), iso(layout.cols, layout.rows + 1), iso(0, layout.rows + 1)])}
            fill={`url(#${gradId})`}
            pointerEvents="none"
          />
        </g>

        {/* filament shelf on the left wall: two planks on brackets, the spools on the upper one */}
        <g aria-hidden="true" data-farm-shelf>
          {layout.shelf.brackets.map((b, i) => (
            <line key={`bracket-${i}`} x1={b.a.x} y1={b.a.y} x2={b.b.x} y2={b.b.y} stroke="#3a3a40" strokeWidth="1.2" />
          ))}
          {layout.shelf.planks.map((plank, i) => (
            <polygon key={`plank-${i}`} points={pts(plank)} fill="#2e2e33" stroke="#45454c" strokeWidth="0.8" />
          ))}
          {shelfSpools.map((sp, i) => {
            const a = layout.shelf.spoolAnchors[i];
            const fill = colorSwatch(sp.color);
            const fullness = sp.grams_total > 0 ? Math.max(0.35, Math.min(1, sp.grams_left / sp.grams_total)) : 1;
            return (
              <g key={sp.id}>
                <ellipse cx={a.x} cy={a.y - 6.5} rx={5.2} ry={6.5 * fullness} fill={fill} stroke="#0a0a0a" strokeWidth="0.8" />
                <ellipse cx={a.x} cy={a.y - 6.5} rx={1.6} ry={2} fill="#0a0a0a" />
              </g>
            );
          })}
        </g>

        {/* work table by the right wall, with a toolbox on it */}
        <g aria-hidden="true" data-farm-table>
          <polygon points={pts(layout.table.left)} fill="#26262b" stroke="#3a3a40" strokeWidth="0.8" />
          <polygon points={pts(layout.table.right)} fill="#2e2e33" stroke="#3a3a40" strokeWidth="0.8" />
          <polygon points={pts(layout.table.top)} fill="#3a3a40" stroke="#4b4b53" strokeWidth="0.8" />
          <polygon points={pts(layout.toolbox.left)} fill="#4a3f2a" stroke="#6b5a3a" strokeWidth="0.8" />
          <polygon points={pts(layout.toolbox.right)} fill="#5a4c32" stroke="#6b5a3a" strokeWidth="0.8" />
          <polygon points={pts(layout.toolbox.top)} fill="#6b5a3a" stroke="#7d6a45" strokeWidth="0.8" />
        </g>

        {/* the machines, back row first so the front ones overlap correctly */}
        {layout.tiles.map((t) => {
          const p = bySlot.get(t.slot);
          if (!p) {
            return (
              <g key={`empty-${t.slot}`} aria-hidden="true">
                <polygon
                  points={pts(t.corners.map((c) => ({ x: t.cx + (c.x - t.cx) * 0.62, y: t.cy + (c.y - t.cy) * 0.62 })))}
                  fill="none"
                  stroke="#3f3f46"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              </g>
            );
          }
          const tone = healthTone(p.health);
          return (
            <use
              key={p.id}
              href="#fp"
              x={t.cx}
              y={t.cy}
              data-farm-slot={t.slot}
              data-farm-state={p.state}
              className={`${STATE_TEXT[p.state] ?? 'text-zinc-500'} ${p.state === 'printing' ? 'fp-printing' : ''}`}
              style={{ ['--fp-health' as string]: HEALTH_HEX[tone] }}
            />
          );
        })}
      </svg>

      {/* HTML overlays: labels and 44px hit targets */}
      {layout.tiles.map((t) => {
        const p = bySlot.get(t.slot);
        const hit = at(vb, { x: t.cx, y: t.cy - 24 });
        const label = at(vb, { x: t.cx, y: t.cy + 12 });
        if (!p) {
          return (
            <React.Fragment key={`o-${t.slot}`}>
              <button
                type="button"
                data-farm-slot-button={t.slot}
                aria-label={`${s.slotN(t.slot + 1)} — ${s.emptySlot}. ${s.addPrinter}`}
                onClick={(e) => onOpenEmptySlot(t.slot, e.currentTarget)}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-300 press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]/70"
                style={{ left: hit.left, top: hit.top, width: hitW, height: hitH }}
              >
                <Plus aria-hidden="true" className="w-5 h-5" />
              </button>
              <span
                aria-hidden="true"
                className="absolute -translate-x-1/2 pointer-events-none text-[10px] leading-3 text-zinc-600 whitespace-nowrap"
                style={{ left: label.left, top: label.top }}
              >
                {s.emptySlot}
              </span>
            </React.Fragment>
          );
        }
        const name = printerName(p, config, lang);
        const line = machineLine(p, now, s, lang);
        return (
          <React.Fragment key={`o-${p.id}`}>
            <button
              type="button"
              data-farm-slot-button={t.slot}
              aria-label={`${s.openPrinter(name)} — ${line}`}
              onClick={(e) => onOpenPrinter(p, e.currentTarget)}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-xl press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]/70"
              style={{ left: hit.left, top: hit.top, width: hitW, height: hitH }}
            />
            <span
              aria-hidden="true"
              className="absolute -translate-x-1/2 pointer-events-none flex flex-col items-center whitespace-nowrap"
              style={{ left: label.left, top: label.top }}
            >
              <span className="text-[11px] leading-3.5 font-bold text-zinc-200 max-w-[7.5rem] truncate">{name}</span>
              {/* The second line is a state word or a countdown whose unit
                  letters are in the UI language, so it inherits the page
                  direction (format.ts isolates each number+unit token). */}
              <span className={`text-[10px] leading-3.5 tabular-nums ${STATE_TEXT[p.state] ?? 'text-zinc-500'}`} data-farm-duration="room">
                {line}
              </span>
            </span>
          </React.Fragment>
        );
      })}

      {extraSpools > 0 && (
        <span
          aria-hidden="true"
          className="absolute pointer-events-none text-[10px] leading-3 text-zinc-500 tabular-nums"
          style={{ ...at(vb, { x: layout.shelf.spoolAnchors[0].x, y: layout.shelf.spoolAnchors[0].y - 26 }), transform: 'translate(-50%, -100%)' }}
          dir="ltr"
        >
          +{extraSpools}
        </span>
      )}
    </div>
  );
}
