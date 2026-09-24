/**
 * THE CUSTOMER SCREEN MUST NOT BE ABLE TO SHOW A COST.
 *
 * `tests/printQuoteRoutes.test.ts` proves the SERVER never sends one: the
 * customer payload is built by `publicQuote`, which has no cost field to leak.
 * This is the other half — a source guard over the pages, because the failure
 * mode it catches is not a server bug at all. It is somebody reaching for the
 * merchant endpoint from the customer page because "it has more detail", which
 * would publish the platform's margin structure to every visitor (§22).
 *
 * Source guards rather than renders, matching tests/store-isolation.test.ts and
 * tests/storefrontIsolation.test.ts: read the file, strip comments so prose
 * ABOUT a rule is never mistaken for the rule, then assert on the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the customer calculator never calls a merchant-only endpoint', () => {
  const tools = code(read('src/pages/Tools.tsx'));
  const client = code(read('src/lib/printQuote.ts'));

  // `/compare` is the merchant's printer comparison: it returns cost, margin,
  // profit and every component line for every machine a shop owns.
  for (const [name, src] of [['Tools.tsx', tools], ['printQuote.ts', client]] as const) {
    assert.ok(!/\/compare/.test(src), `${name} reaches the merchant comparison endpoint`);
  }

  // And the shared client exposes only the public quote shape, so a page that
  // wanted a cost line would have to write its own fetch to get one.
  assert.ok(/PublicQuoteView/.test(client), 'the shared client must name the public shape');
  assert.ok(!/MerchantQuote|merchantQuote/.test(client), 'the shared client must not carry a merchant shape');
});

test('the customer calculator computes no money of its own', () => {
  // THE rule that keeps this page from drifting from the engine that has to
  // defend the number. Every figure shown is one the Worker sent; the page has
  // no price arithmetic, so it cannot disagree with `priceJob`.
  const tools = code(read('src/pages/Tools.tsx'));
  const money = /(price|cost|iqd|total)\w*\s*[*/+]\s*|[*/+]\s*\w*(price|cost|iqd)/i;
  assert.ok(!money.test(tools), 'the calculator page does arithmetic on money');
  // Grams and minutes ARE summed here — adding up what the server already
  // named per material is presentation, not pricing.
  assert.ok(/reduce\(/.test(tools), 'the per-material totals are still derived from the payload');
});

/**
 * THE UPLOAD HAS TO BE VISIBLE WHILE IT IS THE ONLY THING HAPPENING.
 *
 * WHAT THIS CAN AND CANNOT PROVE, stated because a source guard that oversells
 * itself is worse than none. It cannot prove the row looks right — that needs a
 * browser, and the page pulls in the router, the language and the currency
 * contexts. What it CAN prove is the structural fact the bug turned on: the
 * Calculate button, which carries the spinner for the measuring and pricing
 * legs, is rendered behind `analysisId` — and `analysisId` does not exist until
 * the upload has already finished. So the upload leg has nowhere to show itself
 * unless the FILE ROW shows it, and this pins that it still does.
 *
 * And it pins the other half: no percentage. `uploadModel` is a single
 * `fetch`, which reports no progress, so any number on this screen would be
 * invented — the same rule the header of `components/header.tsx` states and
 * the same one the Studio's frozen 87% is a lesson in.
 */
test('the calculator shows the upload on the file row, and invents no percentage', () => {
  const tools = code(read('src/pages/Tools.tsx'));

  // The Calculate button — and therefore its spinner — is gated on analysisId.
  assert.match(tools, /\{analysisId && \(/, 'the Calculate button is no longer gated on analysisId');

  // So the upload leg is surfaced on its own, from a flag the file row reads.
  assert.match(tools, /stage === 'uploading'/, 'nothing distinguishes the upload leg any more');
  const fileRow = tools.slice(tools.indexOf('{file ? ('), tools.indexOf('{s.change}'));
  assert.ok(fileRow.length > 0, 'the file row could not be located');
  assert.match(fileRow, /uploading/, 'the file row shows nothing while the file is going up');
  assert.match(fileRow, /s\.uploading/, 'the file row must say so in the customer\'s language');

  // A spinner, not a number. Anything shaped like a progress percentage here
  // would be fabricated.
  assert.ok(!/upload[A-Za-z]*(Percent|Progress)/i.test(tools), 'the upload must not carry a fabricated percentage');
  assert.ok(!/<progress[^>]*value=/.test(tools), 'a valued progress bar claims a number nobody measured');
});

test('the merchant costing panel is reachable only from the merchant dashboard', () => {
  // The workspace's screen table (W3-A) is where the dashboard mounts its tabs.
  const dashboard = code(read('src/components/merchant/shell/sections.tsx'));
  assert.match(dashboard, /CostingTab/, 'the dashboard must mount the costing tab');

  // No customer-facing page may import it. The list is every page a signed-out
  // or ordinary visitor can reach that could plausibly want print pricing.
  for (const page of ['src/pages/Tools.tsx', 'src/pages/Requests.tsx', 'src/pages/Community.tsx']) {
    assert.ok(!/CostingTab/.test(code(read(page))), `${page} imports the merchant costing panel`);
  }
});

test('the engine treats a geometric estimate and a slice as different things', () => {
  // The one string that tells a reader which engine produced a number. If this
  // ever matched a slicer name, a customer's estimate would be indistinguishable
  // from a merchant's measurement in every log, payload and screen.
  const adapter = code(read('worker/lib/printQuote/geometryAdapter.ts'));
  assert.match(adapter, /slicerVersion: 'levonis-geometry@1'/);
  assert.match(adapter, /provenance: 'platform'/);
  assert.ok(!/provenance: 'measured'/.test(adapter), 'the geometry path must never claim to have measured');
});
