/**
 * «صفحة المحادثات + صفحة الحساب بال light mode حل المشكلة.»
 *
 * THIS APP HAS NO LIGHT THEME, and that is a decision, not an oversight:
 * `html` is pinned `color-scheme: dark` and `#0b0c0f` in src/index.css, and
 * every shared component is tokenised for that one ground.
 *
 * Exactly two pages — /chats and /profile, plus four profile sub-components —
 * were written as a hand-rolled light/dark PAIR (`bg-white dark:bg-[#1a1a1a]`,
 * `text-black dark:text-white`). Tailwind v4 is used with no config file and
 * no `@custom-variant dark`, so `dark:` compiles to
 * `@media (prefers-color-scheme: dark)`. On a phone set to LIGHT the dark half
 * simply evaporated and the LIGHT half painted: a cream page inside a
 * permanently black app, with every shared component — tokenised, therefore
 * always dark — landing on top of it. That is the grey-on-grey the owner
 * photographed, and `color-scheme: dark` does not satisfy
 * `prefers-color-scheme`, so nothing on the page could save it.
 *
 * The light half was DELETED rather than completed. There is no light theme to
 * complete it into, and building one would be a new feature rather than a fix.
 *
 * The behaviour is proved by rendering under an emulated light preference —
 * scripts/e2e-light-mode.mjs. This file pins the rule that stops it coming
 * back one class at a time.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(rel);
  }
  return out;
}

test('no file in src/ styles a light theme that the app does not have', () => {
  const offenders: string[] = [];
  for (const file of walk('src')) {
    // Comments stripped: the rule is explained in prose, quoting the very
    // classes it forbids, in the two files that used to carry them.
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(/(?:^|[\s"'`{])((?:[a-z-]+:)*dark:[a-z-]+[^\s"'`]*)/g)) {
      offenders.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the \`dark:\` variant is back. It compiles to @media (prefers-color-scheme: dark), so on a\n` +
      `light-set phone these styles vanish and whatever is beside them paints instead:\n${offenders.join('\n')}`
  );
});

test('the app still declares itself dark-only, which is why the rule above holds', () => {
  const css = read('src/index.css');
  assert.match(css, /color-scheme:\s*dark/, 'the dark-only declaration moved');
  assert.match(css, /--color-canvas:\s*#0b0c0f/, 'the canvas token moved');
  // No config file and no custom variant — so `dark:` really is the OS query.
  const files = readdirSync(ROOT);
  assert.ok(
    !files.some((f) => /^tailwind\.config\./.test(f)),
    'a tailwind config appeared — re-check what the `dark` variant now compiles to'
  );
  assert.ok(!/@custom-variant\s+dark/.test(css), 'a custom dark variant appeared — re-check this rule');
});

test('the two pages the owner photographed use the shell’s own ground', () => {
  for (const page of ['src/pages/Chats.tsx', 'src/pages/Profile.tsx']) {
    const src = read(page).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.match(
      src,
      /min-h-screen[^"]*bg-canvas|bg-canvas[^"]*min-h-screen/,
      `${page} does not sit on the shell's own ground`
    );
    // The cream PAGE ground is gone for good. Individual white elements are
    // not the defect and some are required: the QR card must be white to be
    // scannable, and the avatar pip is a deliberate disc behind a logo.
    assert.ok(!src.includes('#f2f2f2'), `${page} still carries the cream page ground`);
  }
});
