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
const FIRST: CharacterRender = sampleCharacter({ t: 0, state: 'idle', from: null, age: 9, travel: null, attention: null, intro: null, reduced: false });

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
  const bounce = React.useRef<SVGPathElement>(null);
  const mouth = React.useRef<SVGPathElement>(null);
  const eyeA = React.useRef<SVGEllipseElement>(null);
  const eyeB = React.useRef<SVGEllipseElement>(null);
  const glowA = React.useRef<SVGEllipseElement>(null);
  const glowB = React.useRef<SVGEllipseElement>(null);
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
        put(bounce.current, 'bounce', 'd', r.bounce);
        put(mouth.current, 'mouth', 'd', r.mouth);
        put(mouth.current, 'mouthWeight', 'stroke-width', String(r.mouthWeight));
        const eyes = [eyeA.current, eyeB.current];
        const glows = [glowA.current, glowB.current];
        for (let i = 0; i < 2; i++) {
          const node = eyes[i];
          const eye = r.eyes[i]!;
          if (!node) continue;
          put(node, `eye${i}t`, 'transform', eye.matrix);
          put(node, `eye${i}x`, 'rx', String(eye.rx));
          put(node, `eye${i}y`, 'ry', String(eye.ry));
          // The glow shares the eye's matrix exactly and only scales its
          // radii, so there is no second place for it to be wrong.
          const glow = glows[i];
          if (glow) {
            put(glow, `glow${i}t`, 'transform', eye.matrix);
            put(glow, `glow${i}x`, 'rx', String(Math.round(eye.rx * 210) / 100));
            put(glow, `glow${i}y`, 'ry', String(Math.round(eye.ry * 150) / 100));
          }
          // An eye that has gone round the side of the head is not drawn
          // small, it is not drawn. Scaling it to nothing leaves a sliver
          // clinging to the limb.
          const shown = eye.visible ? '' : 'none';
          if (written.current[`eye${i}v`] !== shown) {
            written.current[`eye${i}v`] = shown;
            node.style.display = shown;
            if (glow) glow.style.display = shown;
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
        {/*
          THE MATERIAL, MEASURED OFF THE REFERENCE RENDER.

          A single radial gradient rather than the old linear one, because the
          reference is lit by one soft source up and to the left and falls away
          in every direction from it — which is what a rounded solid does and
          what a linear ramp cannot say. The olive is also markedly lighter
          than the character carried before: the old fill bottomed out at
          #10130a, near enough to black that the silhouette disappeared into a
          dark page and the body needed an outline drawn round it to be seen at
          all. Give the material its own value range and it holds its shape
          unaided, which is why there is no longer a stroke anywhere on it.
        */}
        <radialGradient id="levonis-bloub-fill" cx="0.34" cy="0.26" r="0.92">
          <stop offset="0" stopColor="#5e6836" />
          <stop offset="0.45" stopColor="#49512a" />
          <stop offset="0.78" stopColor="#353c1e" />
          <stop offset="1" stopColor="#252a15" />
        </radialGradient>
        {/*
          THE HIGHLIGHT IS A GRADIENT THAT ENDS IN NOTHING.

          Its shape (character/body.ts `glossPath`) is a closed lens with
          tapered ends, and this fill is already fully transparent before it
          reaches that lens's boundary — so the geometry has no visible edge
          anywhere and what the eye sees is a soft lobe of lighter olive inside
          the material. That is the whole difference between a highlight and a
          white line laid on top of a shape. objectBoundingBox units mean the
          gradient follows the lens as the body deforms, with nothing to
          recompute per frame.
        */}
        <radialGradient id="levonis-bloub-gloss" cx="0.48" cy="0.44" r="0.62">
          <stop offset="0" stopColor="#c9d49a" stopOpacity="0.34" />
          <stop offset="0.5" stopColor="#aebb82" stopOpacity="0.15" />
          <stop offset="1" stopColor="#aebb82" stopOpacity="0" />
        </radialGradient>
        {/* The bounce: the same idea an order of magnitude quieter. */}
        <radialGradient id="levonis-bloub-bounce" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#8f9a63" stopOpacity="0.16" />
          <stop offset="1" stopColor="#8f9a63" stopOpacity="0" />
        </radialGradient>
        {/* A breath of warmth around each eye, so the cream sits IN the olive
            rather than being punched through it. Again: transparent at its own
            edge, so it can never read as a ring. */}
        <radialGradient id="levonis-bloub-eyeglow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.45" stopColor="#f6edd6" stopOpacity="0.3" />
          <stop offset="1" stopColor="#f6edd6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* No stroke. The brief is explicit that the character has no outer
          outline, and the lighter material above is what makes that possible:
          the silhouette is carried by its own value, not by a line round it. */}
      <path ref={body} data-bloub-body d={FIRST.body} fill="url(#levonis-bloub-fill)" />
      <path ref={bounce} data-bloub-bounce d={FIRST.bounce} fill="url(#levonis-bloub-bounce)" />
      <path ref={gloss} data-bloub-gloss d={FIRST.gloss} fill="url(#levonis-bloub-gloss)" />

      {/* Eyes carry no transform of their own in the markup: the whole pose,
          including where each eye sits, how it is inclined and how far the lid
          has come down, is one matrix written per frame. The glow rides the
          SAME matrix, so it cannot drift off the eye it belongs to. */}
      <ellipse ref={glowA} data-bloub-eyeglow="0" rx={FIRST.eyes[0].rx * 2.1} ry={FIRST.eyes[0].ry * 1.5} transform={FIRST.eyes[0].matrix} fill="url(#levonis-bloub-eyeglow)" />
      <ellipse ref={glowB} data-bloub-eyeglow="1" rx={FIRST.eyes[1].rx * 2.1} ry={FIRST.eyes[1].ry * 1.5} transform={FIRST.eyes[1].matrix} fill="url(#levonis-bloub-eyeglow)" />
      <ellipse ref={eyeA} data-bloub-eye="0" rx={FIRST.eyes[0].rx} ry={FIRST.eyes[0].ry} transform={FIRST.eyes[0].matrix} fill="#f7efda" />
      <ellipse ref={eyeB} data-bloub-eye="1" rx={FIRST.eyes[1].rx} ry={FIRST.eyes[1].ry} transform={FIRST.eyes[1].matrix} fill="#f7efda" />

      <path
        ref={mouth}
        data-bloub-mouth
        d={FIRST.mouth}
        fill="none"
        stroke="#f7efda"
        strokeOpacity="0.92"
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
