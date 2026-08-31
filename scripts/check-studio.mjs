#!/usr/bin/env node
/**
 * Typecheck the Studio workspace as part of the repo's `npm run check`.
 *
 * WHY THIS EXISTS. `npm run check` covered src/, worker/ and tests/, and
 * `eslint.config.js` ignores `studio/**` outright — so the Studio was outside
 * every check the repo runs. On 2026-08-30 a single backtick inside a comment
 * that lives INSIDE a template literal (app/editor-theme.ts) made the Studio
 * impossible to build. `npm run check` still reported 0 errors and 612 passing
 * tests, the branding fix was committed and never shipped, and the owner
 * reported the Studio "unchanged" — for a full day, with nothing anywhere
 * saying why. The failure only surfaced in the server pass of a deploy.
 *
 * A check that cannot see half the product is worse than no check, because it
 * reads as a clean bill of health. This closes that hole.
 *
 * It runs the Studio's OWN tsc against its OWN tsconfig, because the Studio is
 * a separate npm workspace with its own dependency tree. If those dependencies
 * are not installed this FAILS rather than skipping: a check that quietly
 * passes when it did not run is the exact bug it was written to prevent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = join(ROOT, 'studio');
const TSC = join(STUDIO, 'node_modules', '.bin', 'tsc');

if (!existsSync(TSC)) {
  console.error(
    'check-studio: the Studio workspace is not installed, so it was NOT checked.\n' +
      '  Install it first:  (cd studio && npm ci)\n' +
      '  (This is a hard failure on purpose. Reporting "0 errors" for code that\n' +
      '   was never looked at is how a broken Studio shipped for a day.)'
  );
  process.exit(1);
}

try {
  execFileSync(TSC, ['--noEmit'], { cwd: STUDIO, stdio: 'inherit' });
  console.log('check-studio: studio/ typechecks clean');
} catch {
  console.error('check-studio: the Studio workspace does not typecheck (see above)');
  process.exit(1);
}
