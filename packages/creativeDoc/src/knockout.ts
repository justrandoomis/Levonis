/**
 * WHITE BACKDROP KNOCKOUT — a catalogue photo on white, made to sit on a dark
 * template (the house look's podium).
 *
 * A flood fill from the picture's edges over near-white, low-chroma pixels:
 * only backdrop CONNECTED to the border goes, so a white part inside the
 * product (a label, a white spool) stays. The light grey of a soft floor
 * shadow becomes a dark, translucent shadow instead of a grey halo. Then the
 * product's box is the bounding box of the big opaque regions — a small
 * island (a corner badge, a "sold separately" footnote) is cleared too and
 * left out of the box, so the layout can stand the product on its podium.
 *
 * Pure (RGBA bytes in, RGBA bytes out), so the renderer, New design and the
 * tests share one implementation. The stored picture is never changed.
 */

export interface KnockoutResult {
  /** The content box in source pixels, or null when nothing but backdrop was found. */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

/** Brightness at or above this, with little colour, is backdrop when it touches the border. */
const SEED = 236;
/** Down to this, a border-connected pixel is a shadow: kept as translucent black. */
const SHADOW = 214;
const CHROMA = 14;
/** An opaque region smaller than this share of the largest one is an island (a badge, a footnote). */
const ISLAND = 0.08;
/** A pure-white pocket enclosed by the product (the inside of an open frame) larger than this share of the picture is backdrop too. */
const POCKET = 0.004;
const POCKET_LUM = 246;

export function knockoutWhite(px: Uint8ClampedArray, width: number, height: number): KnockoutResult {
  const n = width * height;
  const lum = new Uint8Array(n);
  const flat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000;
    flat[i] = Math.max(r, g, b) - Math.min(r, g, b) <= CHROMA ? 1 : 0;
  }
  // 1) Flood from the border through backdrop and shadow pixels.
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const push = (i: number) => {
    if (seen[i] || !flat[i] || lum[i] < SHADOW || px[i * 4 + 3] === 0) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < n - width) push(i + width);
  }
  for (let i = 0; i < n; i++) {
    if (!seen[i]) continue;
    if (lum[i] >= SEED) px[i * 4 + 3] = 0;
    else {
      // A shadow: as dark as it was grey, never more opaque than the picture was.
      const a = Math.round(((SEED - lum[i]) / (SEED - SHADOW)) * 0.55 * px[i * 4 + 3]);
      px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 0; px[i * 4 + 3] = a;
    }
  }
  // 1b) Large pure-white pockets the product encloses (seen through an open frame) are backdrop too.
  const pocket = new Uint8Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || pocket[s0] || !flat[s0] || lum[s0] < POCKET_LUM) continue;
    const members: number[] = [];
    pocket[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= n || seen[j] || pocket[j] || !flat[j] || lum[j] < POCKET_LUM) continue;
        pocket[j] = 1;
        stack.push(j);
      }
    }
    if (members.length >= n * POCKET) for (const i of members) { seen[i] = 1; px[i * 4 + 3] = 0; }
  }
  // 2) The opaque regions (8-connected); islands are cleared, the rest bound the product.
  const label = new Int32Array(n).fill(-1);
  const regions: Array<{ size: number; x1: number; y1: number; x2: number; y2: number }> = [];
  const solid = (i: number) => !seen[i] && px[i * 4 + 3] > 24;
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || !solid(s)) continue;
    const id = regions.length;
    const reg = { size: 0, x1: width, y1: height, x2: -1, y2: -1 };
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width, y = (i - x) / width;
      reg.size++;
      if (x < reg.x1) reg.x1 = x;
      if (x > reg.x2) reg.x2 = x;
      if (y < reg.y1) reg.y1 = y;
      if (y > reg.y2) reg.y2 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (label[j] === -1 && solid(j)) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    regions.push(reg);
  }
  if (!regions.length) return { bounds: null };
  const largest = Math.max(...regions.map((r) => r.size));
  const keep = regions.map((r) => r.size >= largest * ISLAND);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  regions.forEach((r, i) => {
    if (!keep[i]) return;
    x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1); x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
  });
  for (let i = 0; i < n; i++) if (label[i] >= 0 && !keep[label[i]]) px[i * 4 + 3] = 0;
  return { bounds: { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 } };
}
