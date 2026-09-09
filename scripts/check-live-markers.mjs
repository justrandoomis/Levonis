#!/usr/bin/env node
/**
 * EVERY MARKER A LIVE CHECK GREPS FOR MUST SURVIVE THE MINIFIER.
 *
 * The live verification workflows prove a fix shipped by grepping the served
 * modules for a string only that fix produces. That is a good check with one
 * sharp edge: an IDENTIFIER (`rowCells`, `primaryRepair`) is renamed by the
 * bundler, so grepping for one fails on a bundle that carries the fix
 * perfectly — a false red that costs a deploy cycle to diagnose. It happened
 * once; this script is why it happens once.
 *
 * Run after `npm run build`. It reads the markers out of the workflow file
 * itself, so a marker added to the workflow is checked here with no second
 * edit, and asserts each one is present in dist/.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/verify-live-product-template.yml';
const DIST = 'dist/assets';

const yaml = readFileSync(WORKFLOW, 'utf8');

// Only the step this script guards: the markers of the 2026-09-09 round.
const step = yaml.split('- name: The product-form round is live')[1] ?? '';
if (!step) {
  console.error('check-live-markers: the product-form step is gone from ' + WORKFLOW);
  process.exit(1);
}
const markers = [...step.matchAll(/grep -l '([^']+)'/g)].map((m) => m[1]);
if (markers.length === 0) {
  console.error('check-live-markers: that step greps for nothing');
  process.exit(1);
}

const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
  console.error('check-live-markers: no built modules in ' + DIST + ' — run `npm run build` first');
  process.exit(1);
}
const bundles = files.map((f) => ({ f, text: readFileSync(join(DIST, f), 'utf8') }));

let bad = 0;
for (const marker of markers) {
  const hit = bundles.find((b) => b.text.includes(marker));
  if (hit) {
    console.log(`  ok   ${marker}  →  ${hit.f}`);
  } else {
    console.log(`  FAIL ${marker} is in the workflow but NOT in any built module`);
    console.log('       (an identifier? the minifier renames those — grep for a string literal or a data-* value)');
    bad += 1;
  }
}
console.log(
  bad === 0
    ? `check-live-markers: all ${markers.length} live markers survive the build`
    : `check-live-markers: ${bad} of ${markers.length} markers would fail live verification`
);
process.exit(bad === 0 ? 0 : 1);
