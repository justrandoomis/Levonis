/**
 * Barcode IMAGES for tests, drawn from first principles — no encoder
 * dependency. Code 128 (set B, which covers every serial on a Bambu label)
 * and EAN-13, rendered as one-byte-per-pixel luminance (0 = bar, 255 = paper)
 * so they can be handed straight to the 1-D reader
 * (src/components/scanner/zxingReader.ts).
 */

/** Code 128 bar/space widths for symbol values 0–106 (106 = STOP, 7 elements). */
const CODE128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 ' +
  '232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 ' +
  '313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 ' +
  '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
  '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

/** Module pattern (true = bar) of a Code 128-B symbol for `text`. */
export function code128Modules(text: string): boolean[] {
  const values = [104];
  for (const ch of text) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) throw new Error(`not in Code 128 set B: ${ch}`);
    values.push(v);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check, 106);
  const out: boolean[] = [];
  for (const v of values) {
    [...CODE128[v]].forEach((w, i) => {
      for (let k = 0; k < Number(w); k++) out.push(i % 2 === 0);
    });
  }
  return out;
}

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Module pattern of an EAN-13 symbol (13 digits, check digit included). */
export function ean13Modules(digits: string): boolean[] {
  if (!/^\d{13}$/.test(digits)) throw new Error('EAN-13 needs 13 digits');
  const d = [...digits].map(Number);
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (PARITY[d[0]][i] === 'L' ? L : G)[d[i + 1]];
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R[d[i]];
  bits += '101';
  return [...bits].map((b) => b === '1');
}

export interface Luma {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function blank(width: number, height: number): Luma {
  return { data: new Uint8ClampedArray(width * height).fill(255), width, height };
}

/** Draws a symbol's modules at (x, y), `px` pixels per module, `h` pixels tall. */
export function drawModules(img: Luma, modules: boolean[], x: number, y: number, px: number, h: number): void {
  modules.forEach((bar, i) => {
    if (!bar) return;
    for (let yy = y; yy < Math.min(img.height, y + h); yy++) {
      for (let xx = x + i * px; xx < Math.min(img.width, x + (i + 1) * px); xx++) img.data[yy * img.width + xx] = 0;
    }
  });
}
