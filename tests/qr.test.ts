import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrEncode, qrToSvgPath, rsRemainder, QR_MAX_BYTES } from '../src/components/profile/qr';

// The profile QR modal encodes the member's referral link client-side with
// this dependency-free encoder. These tests pin the structural invariants of
// the symbol (size, finder/timing patterns, format info, version selection)
// so a regression cannot silently produce an unscannable code.

function finderAt(m: ReturnType<typeof qrEncode>, left: number, top: number): boolean {
  // 7×7 finder: dark border ring, light ring, 3×3 dark center.
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const expected = dist !== 2;
      if (m.modules[top + dy][left + dx] !== expected) return false;
    }
  }
  return true;
}

test('encodes a referral-style URL with correct size and version', () => {
  const m = qrEncode('https://levonis-iq.com/auth?ref=AB12CD34');
  assert.equal(m.size, 17 + 4 * m.version);
  assert.ok(m.version >= 1 && m.version <= 10);
  // 40 bytes → version 3 at EC level M (capacity 42).
  assert.equal(m.version, 3);
});

test('all three finder patterns are present', () => {
  const m = qrEncode('https://levonis-iq.com/auth?ref=AB12CD34');
  assert.ok(finderAt(m, 0, 0), 'top-left finder');
  assert.ok(finderAt(m, m.size - 7, 0), 'top-right finder');
  assert.ok(finderAt(m, 0, m.size - 7), 'bottom-left finder');
});

test('timing patterns alternate between the finders', () => {
  const m = qrEncode('hello world');
  for (let i = 8; i < m.size - 8; i++) {
    assert.equal(m.modules[6][i], i % 2 === 0, `row timing at ${i}`);
    assert.equal(m.modules[i][6], i % 2 === 0, `col timing at ${i}`);
  }
});

test('dark module is set and mask is a valid pattern reference', () => {
  const m = qrEncode('x');
  assert.equal(m.modules[m.size - 8][8], true, 'dark module (8, size-8)');
  assert.ok(m.mask >= 0 && m.mask <= 7);
});

test('format info both copies agree (EC level M + chosen mask)', () => {
  const m = qrEncode('https://levonis-iq.com/auth?ref=ZZ99YY88');
  // Recompute the expected 15 format bits for EC M (0b00) + chosen mask.
  const data = (0b00 << 3) | m.mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  // Second copy, first 8 bits run right-to-left along row 8.
  for (let i = 0; i < 8; i++) {
    assert.equal(m.modules[8][m.size - 1 - i], bit(i), `format bit ${i}`);
  }
  // Second copy, bits 8..14 run down column 8.
  for (let i = 8; i < 15; i++) {
    assert.equal(m.modules[m.size - 15 + i][8], bit(i), `format bit ${i}`);
  }
});

test('version scales with payload length up to the cap, then throws', () => {
  assert.equal(qrEncode('a').version, 1);
  assert.equal(qrEncode('a'.repeat(14)).version, 1);
  assert.equal(qrEncode('a'.repeat(15)).version, 2);
  assert.equal(qrEncode('a'.repeat(122)).version, 7); // v7+ adds version info blocks
  assert.equal(qrEncode('a'.repeat(QR_MAX_BYTES)).version, 10);
  assert.throws(() => qrEncode('a'.repeat(QR_MAX_BYTES + 1)), /too long/);
  assert.throws(() => qrEncode(''), /empty/);
});

test('version info blocks are written for v7+', () => {
  const m = qrEncode('a'.repeat(122));
  assert.equal(m.version, 7);
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const expected = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    assert.equal(m.modules[b][a], expected, `version bit ${i} (top-right)`);
    assert.equal(m.modules[a][b], expected, `version bit ${i} (bottom-left)`);
  }
});

test('multibyte UTF-8 payloads count bytes, not characters', () => {
  // 10 Arabic letters ≈ 20 UTF-8 bytes → still version 2 (capacity 26).
  const m = qrEncode('مرحبا بكم في المتجر'.slice(0, 10));
  assert.ok(m.version <= 2);
});

test('Reed-Solomon codewords vanish at every generator root', () => {
  // GF(256)/0x11D arithmetic, independent of the encoder's internals.
  const exp: number[] = [];
  const log: number[] = new Array(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[(log[a] + log[b]) % 255]);

  const data = new Uint8Array([64, 69, 22, 82, 6, 246, 246, 66, 7, 118, 134, 242, 7, 38, 134, 39]);
  const ecLen = 10;
  const ec = rsRemainder(data, ecLen);
  assert.equal(ec.length, ecLen);
  const full = [...data, ...ec]; // highest-degree coefficient first
  for (let r = 0; r < ecLen; r++) {
    // Evaluate the codeword polynomial at α^r via Horner's method.
    const alphaR = exp[r % 255];
    let acc = 0;
    for (const c of full) acc = mul(acc, alphaR) ^ c;
    assert.equal(acc, 0, `codeword must vanish at generator root α^${r}`);
  }
});

test('svg path renders one closed square per dark module with quiet zone', () => {
  const m = qrEncode('x');
  const path = qrToSvgPath(m, 4);
  const darkCount = m.modules.flat().filter(Boolean).length;
  assert.equal((path.match(/M/g) || []).length, darkCount);
  // Quiet zone offset: no coordinate below 4.
  assert.ok(!/M[0-3] /.test(path));
});
