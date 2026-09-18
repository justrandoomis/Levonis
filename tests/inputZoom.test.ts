/**
 * TYPING MUST NOT ZOOM THE PAGE, AND THE FLOOR MUST STAY REACHABLE.
 *
 * Mobile Safari zooms the viewport whenever a focused text control computes to
 * less than 16px, and it does not zoom back out — the customer is left on a
 * form that no longer fits the screen, mid-sentence. The owner reported it as
 * "on some devices the page zooms a little when I type in a field".
 *
 * The fix is one rule in `src/index.css`: on a coarse pointer, every text
 * control is raised to 16px. This suite guards the two ways that rule can stop
 * working, neither of which any type checker or linter would notice:
 *
 *   1. THE RULE IS DELETED OR WEAKENED. It is the only thing standing between
 *      143 small controls and the zoom, and without `!important` it loses to
 *      Tailwind's own `text-sm` — so its shape is asserted, not just its
 *      presence.
 *
 *   2. A CONTROL DECLARES A SIZE THE RULE CANNOT SEE. The larger sizes are
 *      excluded BY NAME (`.text-lg` and up) so a deliberately large control
 *      keeps its size. An ARBITRARY size — `text-[18px]` — has no name in that
 *      list, so the floor would silently shrink it. There are none today; this
 *      test is what says so tomorrow.
 *
 * It reads the source rather than a browser because the question is about what
 * the stylesheet says, and a headless browser would answer a different one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const SRC = join(ROOT, 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx|jsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** The opening tag of every text-entry control, as written. */
function controls(src: string): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/<(input|textarea|select)\b/.test(lines[i])) continue;
    let buf = '';
    for (let j = i; j < lines.length && j < i + 40; j++) {
      buf += `${lines[j]}\n`;
      if (j > i && /\/>|>\s*$/.test(lines[j])) break;
    }
    out.push(buf);
  }
  return out;
}

test('the coarse-pointer floor is in index.css, and it still wins against a utility', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');
  assert.ok(/@media\s*\(pointer:\s*coarse\)/.test(css), 'the rule is keyed on a coarse pointer');
  assert.ok(
    /font-size:\s*16px\s*!important/.test(css),
    'without !important the floor loses to Tailwind`s own text-sm, which is the thing it is a floor for'
  );
  for (const tag of ['input', 'select', 'textarea']) {
    assert.ok(new RegExp(`\\n\\s*${tag}:not\\(`).test(css), `${tag} is covered by the floor`);
  }
  // Excluded by name so a deliberately larger control keeps its size.
  assert.ok(/\.text-lg/.test(css), 'the larger sizes are excluded rather than clamped');
});

test('NO CONTROL DECLARES AN ARBITRARY SIZE ABOVE 16px — the floor could not see it', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const tag of controls(src)) {
      for (const m of tag.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) > 16) offenders.push(`${file.replace(`${SRC}/`, '')} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'an arbitrary size has no class name the floor can exclude, so it would be silently shrunk to 16px on every phone. ' +
      'Use text-lg / text-xl (which the rule excludes by name), or accept 16px.'
  );
});

test('the viewport meta still allows pinch-zoom', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const meta = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta, 'the page declares a viewport');
  // `maximum-scale=1` / `user-scalable=no` stop the focus zoom by stopping ALL
  // zoom, including the pinch somebody with poor eyesight needs to read the
  // page. That is an accessibility regression traded for a layout one, and the
  // CSS floor exists precisely so nobody reaches for it.
  assert.equal(/maximum-scale/.test(meta[1]), false, 'never cap the scale to stop the focus zoom');
  assert.equal(/user-scalable\s*=\s*no/.test(meta[1]), false, 'never disable zoom to stop the focus zoom');
});
