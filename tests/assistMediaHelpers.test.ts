/**
 * FRAMES FROM A CLIP, THE PURE HALF (push B1, plan §5.3, §16 #20).
 *
 * src/lib/assistMedia.ts takes 2-4 JPEG frames from an owned clip in the
 * browser. Its seek points and its scaling are pure and are pinned here; the
 * part that needs a video element is never reached in Node, where it answers
 * with no frames rather than throwing (the page then says `frames_failed` and
 * calls nothing). The owner vision Test draws a made-up code in the shape of a
 * printer error code, which the rules of push A must read back unchanged.
 *
 * Run: node --import tsx --test tests/assistMediaHelpers.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  FRAME_EDGE,
  FRAME_FRACTIONS,
  FRAME_MAX_BYTES,
  MAX_PICK_SECONDS,
  MIN_FRAMES,
  drawCodeTestImage,
  extractFrames,
  fitEdge,
  frameTimes,
  testCode,
} from '../src/lib/assistMedia';
import { HMS_CODE_SHAPE } from '../worker/lib/assist/context';
import { FRAME_LIMITS } from '../worker/lib/ai/jpeg';
import { FRAMES_BODY_MAX_BYTES } from '../worker/routes/assistAi';
import { readHmsCode } from '../worker/lib/assist/understand';

test('frameTimes: four points strictly inside (0, d), in order, at 15, 40, 65 and 90 percent', () => {
  for (const d of [0.4, 1, 7.3, 60, 119.9, 120]) {
    const t = frameTimes(d);
    assert.equal(t.length, 4, `d=${d}`);
    for (const x of t) assert.ok(x > 0 && x < d, `d=${d}: ${x} is not inside (0, d)`);
    assert.deepEqual(t, [...t].sort((a, b) => a - b));
    assert.deepEqual(
      t.map((x) => Math.round((x / d) * 100)),
      [15, 40, 65, 90]
    );
  }
  assert.deepEqual([...FRAME_FRACTIONS], [0.15, 0.4, 0.65, 0.9]);
});

test('frameTimes: no point for a length that is not a finite positive number', () => {
  for (const d of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -3, undefined, null, '12']) {
    assert.deepEqual(frameTimes(d as unknown as number), [], String(d));
  }
});

test('frameTimes: a long clip is read over its first two minutes only', () => {
  const t = frameTimes(3600);
  assert.equal(MAX_PICK_SECONDS, 120);
  assert.deepEqual(t, FRAME_FRACTIONS.map((f) => f * MAX_PICK_SECONDS));
  assert.ok(Math.max(...t) < MAX_PICK_SECONDS);
});

test('fitEdge: the longer side down to the edge, the aspect kept, never scaled up', () => {
  assert.deepEqual(fitEdge(1920, 1080, 1024), { width: 1024, height: 576 });
  assert.deepEqual(fitEdge(1080, 1920, 1024), { width: 576, height: 1024 });
  assert.deepEqual(fitEdge(4032, 3024, 1024), { width: 1024, height: 768 });
  assert.deepEqual(fitEdge(640, 480, 1024), { width: 640, height: 480 });
  assert.deepEqual(fitEdge(1024, 1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(fitEdge(5000, 3, 1024), { width: 1024, height: 1 }, 'a sliver keeps one pixel');
  for (const [w, h] of [[0, 100], [100, 0], [Number.NaN, 10], [10, Number.POSITIVE_INFINITY], [-5, 10]]) {
    assert.deepEqual(fitEdge(w, h, 1024), { width: 0, height: 0 }, `${w}x${h}`);
  }
  assert.deepEqual(fitEdge(100, 100, 0), { width: 0, height: 0 });
});

test('fitEdge: every frame stays inside the server limit for frames (1280) at the edge used', () => {
  assert.equal(FRAME_EDGE, 1024);
  assert.ok(FRAME_EDGE <= 1280, 'the server refuses a frame side over 1280 (plan §5.3)');
  for (let w = 1; w <= 8000; w += 397) {
    for (let h = 1; h <= 8000; h += 311) {
      const r = fitEdge(w, h, FRAME_EDGE);
      assert.ok(r.width >= 1 && r.height >= 1 && r.width <= FRAME_EDGE && r.height <= FRAME_EDGE, `${w}x${h} → ${r.width}x${r.height}`);
      if (Math.max(w, h) <= FRAME_EDGE) assert.deepEqual(r, { width: w, height: h }, 'never scaled up');
    }
  }
});

test('the limits the server holds are the limits the browser aims under', () => {
  assert.equal(MIN_FRAMES, 2, 'fewer than two frames is no reading (plan §5.3)');
  // The server's own numbers (worker/lib/ai/jpeg.ts, worker/routes/assistAi.ts), not a copy of them:
  // a frame the browser keeps must be a frame the server takes.
  assert.equal(MIN_FRAMES, FRAME_LIMITS.min);
  assert.equal(FRAME_FRACTIONS.length, FRAME_LIMITS.max, 'at most four frames');
  assert.equal(FRAME_MAX_BYTES, FRAME_LIMITS.maxBytes, 'each frame at most 400 KB, as the server counts them');
  assert.ok(FRAME_EDGE <= FRAME_LIMITS.maxSide, 'the longest side within the server limit');
  assert.ok(FRAME_LIMITS.max * FRAME_MAX_BYTES < FRAMES_BODY_MAX_BYTES, 'four frames fit the 2 MB body');
});

test('without a document there are no frames and no drawing, and nothing throws', async () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');
  assert.deepEqual(await extractFrames('/files/assist/u1/videos/a.mp4'), []);
  assert.deepEqual(await extractFrames(new Blob([new Uint8Array([0, 0, 0])], { type: 'video/mp4' })), []);
  assert.equal(await drawCodeTestImage('0300-0100-0001-0007'), null);
});

test('the vision Test code is printer-code shaped, read back unchanged by the rules', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = testCode(random);
    assert.match(code, /^0[0-9A-F]{3}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.ok(HMS_CODE_SHAPE.test(code), code);
    assert.equal(readHmsCode(code), code, `${code} is not read back as itself`);
    seen.add(code);
  }
  assert.ok(seen.size > 190, 'a fresh code each Test');
  assert.match(testCode(), /^0[0-9A-F]{3}(-[0-9A-F]{4}){3}$/);
});

/** Every .ts/.tsx file under src/. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

test('the frame taker is reached only through a dynamic import (the read and the owner Test)', () => {
  const statics: string[] = [];
  const dynamics: string[] = [];
  for (const f of sourceFiles('src')) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    if (/^\s*import\s[^;]*from\s+'[./]+(?:lib\/)?assistMedia'/m.test(src)) statics.push(f);
    if (/import\('[./]+(?:lib\/)?assistMedia'\)/.test(src)) dynamics.push(f);
  }
  assert.deepEqual(statics, [], 'a static import would put the frame taker in its importer chunk');
  assert.deepEqual(dynamics.sort(), ['src/components/AdminAssistAi.tsx', 'src/components/support/AssistAttach.tsx']);
});
