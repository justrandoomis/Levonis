/**
 * The live CSP check fails the run on one console violation. That is only
 * sound if the line it reads is a violation of THIS site's ENFORCED policy.
 *
 * WHY THIS EXISTS. Workflow 28 run 8 failed on:
 *
 *   [Report Only] Refused to frame 'https://accounts.google.com/' because an
 *   ancestor violates the following Content Security Policy directive:
 *   "frame-ancestors 'self'".
 *
 * Two things make that not ours. The directive is `frame-ancestors 'self'`
 * and this site's policy says `frame-ancestors 'none'` — so it is a different
 * policy, the one the framed Google sign-in iframe carries. And it is report
 * only: nothing was blocked, sign-in works. This site serves exactly one
 * enforced policy and no report-only policy at all, so a report-only line can
 * never be a failure of ours; treating it as one would make the check fail
 * whenever a third party turns on a report-only policy of their own.
 *
 * These tests pin both halves: report-only is classified apart, and an
 * enforced violation is still a violation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error — a plain .mjs helper shared with the live check
import { classifyCspConsoleLine } from '../scripts/lib/csp-console.mjs';

const GOOGLE_IFRAME_REPORT =
  "[Report Only] Refused to frame 'https://accounts.google.com/' because an ancestor " +
  'violates the following Content Security Policy directive: "frame-ancestors \'self\'".';

test('the report-only line workflow 28 failed on is not counted as a violation', () => {
  assert.equal(classifyCspConsoleLine(GOOGLE_IFRAME_REPORT), 'report-only');
});

test('an enforced violation is still a violation', () => {
  const enforced = [
    "Refused to load the script 'https://evil.example/x.js' because it violates the " +
      "following Content Security Policy directive: \"script-src 'self'\".",
    "Refused to execute inline script because it violates the following Content " +
      "Security Policy directive: \"script-src 'self'\".",
    "Refused to connect to 'https://evil.example/' because it violates the following " +
      "Content Security Policy directive: \"connect-src 'self'\".",
    "Refused to frame 'https://evil.example/' because it violates the following " +
      "Content Security Policy directive: \"frame-src 'none'\".",
  ];
  for (const line of enforced) assert.equal(classifyCspConsoleLine(line), 'violation', line);
});

test('ordinary console noise is neither', () => {
  for (const line of ['favicon.ico 404 (Not Found)', 'React DevTools', '', null, undefined]) {
    assert.equal(classifyCspConsoleLine(line as unknown as string), null);
  }
});

test('this site serves one enforced policy and no report-only policy', () => {
  // The premise the classification rests on: if a report-only policy ever
  // becomes ours, this test fails and the exclusion has to be revisited.
  const policy = readFileSync(new URL('../worker/lib/securityPolicy.ts', import.meta.url), 'utf8');
  assert.ok(
    !/report-only/i.test(policy),
    'securityPolicy.ts now emits a report-only policy — the live check must stop ignoring report-only lines',
  );
  assert.match(policy, /frame-ancestors/, 'securityPolicy.ts no longer sets frame-ancestors');
});

test('the live check routes its console lines through the classifier', () => {
  const script = readFileSync(new URL('../scripts/e2e-security-headers.mjs', import.meta.url), 'utf8');
  assert.match(script, /classifyCspConsoleLine/, 'the live check no longer uses the shared classifier');
  assert.match(script, /notes\.push/, 'report-only lines are dropped instead of printed');
});
