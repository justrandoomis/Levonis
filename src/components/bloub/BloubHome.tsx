import React from 'react';
import { type MascotState } from '../../lib/mascot';
import { VIEWBOX, sampleCharacter, type CharacterRender } from './character/engine';
export type { BloubState } from './events';

/**
 * THE CHARACTER'S BODY. A renderer, and nothing else.
 *
 * Every frame arrives through `apply()` from the one animation loop in
 * AppIntro. This component never schedules a frame, never reads a clock and
 * never re-renders while the character is moving — it holds refs to six nodes
 * and writes attributes onto them.
 *
 * That split is deliberate. The previous version drove the face through React
 * state and a motion library, with one shared transition on every animated
 * property, which had two consequences that no amount of tuning could fix: a
 * component re-render for every visual change, and — because the transition
 * was shared — a body, a pair of eyes and a mouth that were mathematically
 * incapable of moving at different speeds. A character whose every part
 * changes on the same curve is a diagram of a character.
 */

export const BLOUB_VIEWBOX = VIEWBOX;

export interface CharacterHandle {
  /** Write one sampled frame onto the DOM. Called from rAF; does no work
   * beyond six attribute writes. */
  apply(render: CharacterRender): void;
}

/** The frame the markup is born with, so the very first paint — before any
 * loop has run — is already the character at rest rather than an empty box. */
const FIRST: CharacterRender = sampleCharacter({ t: 0, state: 'idle', from: null, age: 9, travel: null, reduced: false });

interface Props {
  state?: MascotState;
  /** Only used to publish `data-reduced`. The engine reads the preference
   * itself, per frame, from the loop — this attribute is how the outside world
   * (and the browser regression) can see which way the character is being
   * drawn without sampling it. */
  reduced?: boolean;
  className?: string;
}

const BloubHome = React.forwardRef<CharacterHandle, Props>(function BloubHome({ state = 'idle', reduced = false, className = '' }, ref) {
  const body = React.useRef<SVGPathElement>(null);
  const gloss = React.useRef<SVGPathElement>(null);
  const mouth = React.useRef<SVGPathElement>(null);
  const eyeA = React.useRef<SVGEllipseElement>(null);
  const eyeB = React.useRef<SVGEllipseElement>(null);
  const alert = React.useRef<SVGGElement>(null);

  /** Last value written to each node. Writing an attribute invalidates the
   * element whether or not the value changed, so a frame in which nothing
   * moved — every frame under a reduced-motion preference, and most frames of
   * a long hold — should cost nothing at all. */
  const written = React.useRef<Record<string, string>>({});

  React.useImperativeHandle(ref, (): CharacterHandle => {
    const put = (node: Element | null, key: string, name: string, value: string) => {
      if (!node || written.current[key] === value) return;
      written.current[key] = value;
      node.setAttribute(name, value);
    };
    return {
      apply(r) {
        put(body.current, 'body', 'd', r.body);
        put(gloss.current, 'gloss', 'd', r.gloss);
        put(mouth.current, 'mouth', 'd', r.mouth);
        put(mouth.current, 'mouthWeight', 'stroke-width', String(r.mouthWeight));
        const eyes = [eyeA.current, eyeB.current];
        for (let i = 0; i < 2; i++) {
          const node = eyes[i];
          const eye = r.eyes[i]!;
          if (!node) continue;
          put(node, `eye${i}t`, 'transform', eye.matrix);
          put(node, `eye${i}x`, 'rx', String(eye.rx));
          put(node, `eye${i}y`, 'ry', String(eye.ry));
          // An eye that has gone round the side of the head is not drawn
          // small, it is not drawn. Scaling it to nothing leaves a sliver
          // clinging to the limb.
          const shown = eye.visible ? '' : 'none';
          if (written.current[`eye${i}v`] !== shown) {
            written.current[`eye${i}v`] = shown;
            node.style.display = shown;
          }
        }
        const alertOpacity = String(r.alert);
        if (alert.current && written.current.alert !== alertOpacity) {
          written.current.alert = alertOpacity;
          alert.current.style.opacity = alertOpacity;
        }
      },
    };
  }, []);

  return (
    <svg
      viewBox={VIEWBOX}
      className={`lv-bloub ${className}`}
      data-expression={state}
      data-reduced={reduced ? 'true' : 'false'}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The established Levonis character: dark olive body, warm gold rim,
            cream face. Unchanged — the brief asks for the same character
            better animated, not a different one. */}
        <linearGradient id="levonis-bloub-fill" x1="18" y1="8" x2="82" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="#30391c" />
          <stop offset="0.58" stopColor="#1b2010" />
          <stop offset="1" stopColor="#10130a" />
        </linearGradient>
        <linearGradient id="levonis-bloub-edge" x1="20" y1="10" x2="80" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d0bd83" stopOpacity="0.72" />
          <stop offset="1" stopColor="#786b43" stopOpacity="0.22" />
        </linearGradient>
      </defs>

      <path
        ref={body}
        data-bloub-body
        d={FIRST.body}
        fill="url(#levonis-bloub-fill)"
        stroke="url(#levonis-bloub-edge)"
        strokeWidth="2"
      />
      <path
        ref={gloss}
        data-bloub-gloss
        d={FIRST.gloss}
        fill="none"
        stroke="#f2e7c6"
        strokeOpacity="0.13"
        strokeWidth="4.4"
        strokeLinecap="round"
      />

      {/* Eyes carry no transform of their own in the markup: the whole pose,
          including where each eye sits, how it is inclined and how far the lid
          has come down, is one matrix written per frame. */}
      <ellipse ref={eyeA} data-bloub-eye="0" rx={FIRST.eyes[0].rx} ry={FIRST.eyes[0].ry} transform={FIRST.eyes[0].matrix} fill="#f3ead0" />
      <ellipse ref={eyeB} data-bloub-eye="1" rx={FIRST.eyes[1].rx} ry={FIRST.eyes[1].ry} transform={FIRST.eyes[1].matrix} fill="#f3ead0" />

      <path
        ref={mouth}
        data-bloub-mouth
        d={FIRST.mouth}
        fill="none"
        stroke="#f3ead0"
        strokeOpacity="0.9"
        strokeWidth={FIRST.mouthWeight}
        strokeLinecap="round"
      />

      {/* Unread work waiting. The only mark the character wears that is not
          part of its face — everything else it has to say, it says with the
          face. */}
      <g ref={alert} data-bloub-alert style={{ opacity: FIRST.alert }}>
        <circle cx="79" cy="21" r="7.5" fill="#e8b84b" />
        <circle cx="79" cy="21" r="7.5" fill="none" stroke="#10130a" strokeWidth="2.4" strokeOpacity="0.55" />
      </g>
    </svg>
  );
});

export default BloubHome;
