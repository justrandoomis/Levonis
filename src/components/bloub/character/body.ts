import { TAU, r2 } from './math';

/**
 * THE BODY IS A RADIUS FUNCTION, NOT A PATH STRING.
 *
 * The old character kept seven hand-authored cubic-Bezier outlines and morphed
 * between them by interpolating control points. That works only while the
 * outlines are drawn with matching control points in matching order, and it
 * can express nothing that was not drawn in advance — in particular it cannot
 * lean into a direction that is only known at runtime, which is precisely what
 * the brief asks the body to do while it travels.
 *
 * Sampling r(theta) instead makes deformation arithmetic. Stretching along an
 * arbitrary axis, bulging behind the direction of travel, squashing on impact
 * and drifting organically are four multiplications on the same array, they
 * compose without fighting each other, and none of them can produce a crossed
 * or kinked outline the way interpolating mismatched Beziers can.
 */

/** Samples around the outline. Twenty-eight is comfortably past the point
 * where the Catmull-Rom fit stops being visible as facets at the largest size
 * the character is ever drawn, and small enough that the whole path fits in a
 * few hundred bytes per frame. */
const SAMPLES = 28;

export interface BodyOptions {
  /** Base radius in viewBox units. */
  radius: number;
  /** Seconds, for the organic drift. */
  t: number;
  /** Amplitude of the resting drift, as a fraction of the radius. */
  wobble: number;
  /** How fast the drift travels around the outline, in turns per second. */
  wobbleRate: number;
  /** Uniform scale. */
  swell: number;
  /** Stretch along `axis`, 0 = none. Volume preserving: what it gains along
   * the axis it gives up across it, so the character never looks like it grew. */
  stretch: number;
  /** Direction of the stretch in radians, screen frame (y down). */
  axis: number;
  /** Bulge BEHIND the direction of travel. This is follow-through: the mass
   * has not caught up with the leading edge yet. */
  trail: number;
  /** Vertical squash, 0 = none. Positive flattens and widens. */
  squash: number;
}

/**
 * The resting deformation.
 *
 * Only the third and fifth harmonics, so the silhouette stays a soft blob
 * whatever the amplitude — higher harmonics turn it into a star, and a
 * character with corners is a different character. The two terms travel round
 * the outline at different rates and in opposite directions, which is what
 * stops the drift from reading as the whole body rotating. Rotation is on the
 * brief's list of things the character must never appear to do.
 */
function drift(theta: number, t: number, rate: number): number {
  return (
    Math.sin(3 * theta + t * rate * TAU) * 0.6 +
    Math.sin(5 * theta - t * rate * 1.63 * TAU + 1.9) * 0.4
  );
}

/** Sample the outline into screen-space points. Exported so geometry can be
 * asserted in tests without parsing a path string back out. */
export function bodyPoints(o: BodyOptions): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const ca = Math.cos(o.axis);
  const sa = Math.sin(o.axis);
  // Volume preservation: gain along the axis is paid for across it.
  const along = 1 + o.stretch;
  const across = 1 / along;
  for (let i = 0; i < SAMPLES; i++) {
    const th = (i / SAMPLES) * TAU;
    // Follow-through leans the mass away from where the character is headed.
    const tail = 1 - o.trail * Math.cos(th - o.axis);
    const r = o.radius * o.swell * (1 + o.wobble * drift(th, o.t, o.wobbleRate)) * tail;
    let x = r * Math.cos(th);
    let y = r * Math.sin(th);
    // Into the travel frame, scale, and back out.
    const u = x * ca + y * sa;
    const v = -x * sa + y * ca;
    const su = u * along;
    const sv = v * across;
    x = su * ca - sv * sa;
    y = su * sa + sv * ca;
    // Impact squash is in screen space: things flatten against the ground
    // they hit, not against the direction they were travelling.
    x *= 1 + o.squash * 0.9;
    y *= 1 - o.squash;
    pts.push([x, y]);
  }
  return pts;
}

/**
 * Closed Catmull-Rom through the samples, emitted as cubic Beziers.
 *
 * Catmull-Rom rather than a plain polyline or quadratics because it passes
 * THROUGH every sample — so the radius function is the outline, exactly, and a
 * deformation of one is a deformation of the other. With quadratics the curve
 * would cut the corners of its own control points and the body would quietly
 * shrink as the wobble grew.
 */
export function pathFromPoints(pts: Array<[number, number]>, cx: number, cy: number): string {
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n]!;
  let d = `M ${r2(cx + at(0)[0])} ${r2(cy + at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${r2(cx + c1x)} ${r2(cy + c1y)} ${r2(cx + c2x)} ${r2(cy + c2y)} ${r2(cx + p2[0])} ${r2(cy + p2[1])}`;
  }
  return `${d} Z`;
}

export function bodyPath(o: BodyOptions, cx: number, cy: number): string {
  return pathFromPoints(bodyPoints(o), cx, cy);
}

/**
 * A HIGHLIGHT THAT IS IN THE MATERIAL, NOT ON IT.
 *
 * The previous gloss was an open arc STROKED in near-white. However low the
 * opacity, a stroke has a constant width and two ends, so it reads as a line
 * someone drew on the character — the exact failure the brief names. What the
 * reference shows instead is a broad soft lobe of lighter olive, brightest
 * somewhere inside the upper-left mass and fading to nothing long before it
 * reaches any edge of itself.
 *
 * So the gloss is now a CLOSED lens, filled with a radial gradient that is
 * already fully transparent at its own boundary. The geometry therefore has no
 * visible edge anywhere — the gradient decides what is seen, and the gradient
 * ends in nothing. The lens is still derived from the SAME body samples, so it
 * deforms with the surface rather than sliding across it, and its ends taper
 * to points rather than being cut off by a chord, which is what stops the two
 * tips from showing as bright commas at high deformation.
 *
 * No SVG filter is involved. A `feGaussianBlur` would have been the obvious
 * way to soften an edge and it re-rasterises the element on every frame the
 * path changes — which here is every frame. A gradient that fades to alpha 0
 * costs the compositor nothing and never blurs the body underneath it.
 *
 * `from`/`to` are fractions of the way round the outline, `depth` is how far
 * the lens reaches in towards the middle at its widest.
 */
function lens(
  pts: Array<[number, number]>,
  cx: number,
  cy: number,
  from: number,
  to: number,
  outer: number,
  depth: number
): string {
  const n = pts.length;
  const i0 = Math.round(n * from);
  const i1 = Math.round(n * to);
  const span = i1 - i0;
  if (span < 2) return '';
  const at = (i: number) => pts[((i % n) + n) % n]!;
  const outward: Array<[number, number]> = [];
  const inward: Array<[number, number]> = [];
  for (let i = i0; i <= i1; i++) {
    const p = at(i);
    const u = (i - i0) / span;
    // sin(pi*u) is 0 at both ends and 1 in the middle: the lens closes to a
    // point where it starts and where it stops, and is at its deepest halfway.
    const belly = Math.sin(Math.PI * u);
    outward.push([p[0] * outer, p[1] * outer]);
    inward.push([p[0] * (outer - depth * belly), p[1] * (outer - depth * belly)]);
  }
  let d = `M ${r2(cx + outward[0]![0])} ${r2(cy + outward[0]![1])}`;
  for (let i = 1; i < outward.length; i++) {
    const prev = outward[i - 1]!;
    const cur = outward[i]!;
    d += ` Q ${r2(cx + prev[0])} ${r2(cy + prev[1])} ${r2(cx + (prev[0] + cur[0]) / 2)} ${r2(cy + (prev[1] + cur[1]) / 2)}`;
  }
  for (let i = inward.length - 1; i >= 0; i--) {
    const cur = inward[i]!;
    const prev = inward[Math.min(i + 1, inward.length - 1)]!;
    d += ` Q ${r2(cx + prev[0])} ${r2(cy + prev[1])} ${r2(cx + (prev[0] + cur[0]) / 2)} ${r2(cy + (prev[1] + cur[1]) / 2)}`;
  }
  return `${d} Z`;
}

/** The main specular: a broad lobe across the upper-left shoulder, where the
 *  reference puts its light. */
export function glossPath(pts: Array<[number, number]>, cx: number, cy: number): string {
  return lens(pts, cx, cy, 0.53, 0.9, 0.92, 0.62);
}

/**
 * The bounce.
 *
 * A much dimmer, thinner lift along the lower-left edge — light coming back up
 * off whatever the character is sitting on. It is the difference between a
 * shape with a highlight and a shape with volume, and it costs one more path.
 * Nothing else in the drawing says the body is round rather than flat.
 */
export function bouncePath(pts: Array<[number, number]>, cx: number, cy: number): string {
  return lens(pts, cx, cy, 0.14, 0.44, 0.97, 0.2);
}
