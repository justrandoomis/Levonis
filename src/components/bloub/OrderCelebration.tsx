import { MotionCharacterAnchor } from './MotionCharacterAnchor';

/**
 * THE MOMENT AN ORDER GOES THROUGH — the stage the character appears on, and
 * the burst it appears into.
 *
 * «الانيميشن bloub عند تأكيد الطلب غير مناسب وغير مرح ويظهر الانيميشن عندما
 * ينتقل من فوق الى الاسفل بشكل خاطئ وبشكل يظهر فيه lagging». Three complaints,
 * three answers:
 *
 *   WRONG MOVEMENT. The character no longer travels from the header down the
 *   page to reach this slot. A stage is appeared at
 *   (`appearsInsteadOfTravelling`, anchors.ts): it pops into being here.
 *
 *   NOT FUN. It pops in overshooting and hops twice for joy
 *   (`character/entrance.ts`), and a burst of confetti goes off behind it — in
 *   the shop's own gold and cream, with one success green, radiating from the
 *   character as it lands. One-shot: nothing here loops, and nothing is left
 *   moving once the news has been read.
 *
 *   LAG. Every piece of motion on this screen is `transform` and `opacity` on
 *   its own compositor layer. The burst is CSS keyframes with fixed values —
 *   no custom property inside a keyframe, which some engines decline to hand to
 *   the compositor — and its direction comes from a STATIC rotation on the arm
 *   each piece rides, so every piece shares one of three keyframe tracks. The
 *   main thread can be as busy as it likes with the confirmation mounting; none
 *   of this waits for it.
 *
 * UNDER REDUCED MOTION the burst is not drawn at all (src/index.css), and the
 * character fades in on the stage instead of popping: the celebration is
 * still SAID — by the heading, and by the character's celebrate face — just
 * not performed.
 *
 * The anchor is the last child, so it is centred in the same box the burst is
 * centred in, and the burst sits UNDER the character: the character is drawn
 * by the fixed layer above the page (`.lv-app-intro`), and the pieces start
 * behind its body and fly out past its edge.
 */

export type BurstReach = 'near' | 'mid' | 'far';
export type BurstShape = 'dot' | 'strip';
export type BurstTone = 'gold' | 'glow' | 'cream' | 'success';

export interface BurstPiece {
  /** Degrees, clockwise from straight up. Static — applied to the arm. */
  angle: number;
  reach: BurstReach;
  shape: BurstShape;
  tone: BurstTone;
  /** Milliseconds after the confirmation mounts that this piece leaves. It
   *  is the piece's whole `animation-delay` (an inline delay replaces the
   *  stylesheet's, it does not add to it). */
  delay: number;
}

/**
 * When the burst goes off, measured from the confirmation mounting. The
 * character's pop reaches full size at 16% of its 1.3s entrance — about 210ms
 * — so the pieces leave while it is still growing through them, which reads
 * as the character bursting INTO view rather than as two unrelated effects.
 */
export const BURST_START_MS = 90;

const REACHES: readonly BurstReach[] = ['mid', 'far', 'near'];
const TONES: readonly BurstTone[] = ['gold', 'cream', 'glow', 'success'];

/**
 * The pieces, as a pure function of their count: evenly spaced round the
 * circle, each nudged off its slot by a deterministic amount so the ring does
 * not read as a clock face, alternating shape, cycling reach and colour, and
 * leaving in four staggered waves. Deterministic because a confetti burst that
 * looks different on every order would be a random number generator in the
 * render path for no gain — and this way its shape is asserted in a test.
 */
export function burstPieces(count = 14): BurstPiece[] {
  return Array.from({ length: count }, (_, i) => ({
    angle: Math.round((i * 360) / count + (((i * 37) % 11) - 5)),
    reach: REACHES[i % REACHES.length],
    shape: i % 2 === 0 ? 'dot' : 'strip',
    tone: TONES[i % TONES.length],
    delay: BURST_START_MS + (i % 4) * 25,
  }));
}

const PIECES = burstPieces();

export default function OrderCelebration() {
  return (
    <div className="lv-celebration" data-order-celebration>
      <div className="lv-celebration__burst" aria-hidden="true">
        <span className="lv-celebration__ring" />
        {PIECES.map((piece, i) => (
          <span key={i} className="lv-celebration__arm" style={{ transform: `rotate(${piece.angle}deg)` }}>
            <span
              className={`lv-celebration__bit lv-celebration__bit--${piece.shape} lv-celebration__bit--${piece.reach}`}
              data-tone={piece.tone}
              style={{ animationDelay: `${piece.delay}ms` }}
            />
          </span>
        ))}
      </div>
      <MotionCharacterAnchor kind="stage" />
    </div>
  );
}
