#!/usr/bin/env node
/**
 * THE ADMIN PANELS ACTUALLY MOUNT.
 *
 * «في التحقق والعناوين في لوحة الإدارة عند الضغط عليها يصبح الموقع بالكامل أسود
 *  شاشة سوداء.»
 *
 * AdminKyc threw on its FIRST RENDER. `{detail.user_email}` sat inside the
 * children of `<Overlay open={!!detail}>`, and JSX children are an ordinary
 * eager argument — built while the props object is constructed, before the
 * Overlay is called and long before it decides whether it is open. So the
 * expression ran with `detail` still null and threw. No data, no click, no API
 * response required: mounting the tab was enough.
 *
 * WHY NO TEST CAUGHT IT, AND WHY THIS ONE IS A BROWSER TEST. `tsconfig.json`
 * sets no `strictNullChecks`, so `CaseDetail | null` is never narrowed and
 * `detail.user_email` is not a type error — `npm run check` passes on the
 * crash. And no test had ever rendered the component; the only reference to it
 * in the suite pins its chunk NAME. A source assertion that a guard exists
 * proves the guard is written. Only a MOUNT proves the panel opens.
 *
 * Run: node scripts/e2e-admin-panels.mjs   (a vite dev server on :4177)
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const base = process.env.ADMIN_TEST_URL || 'http://127.0.0.1:4177/tests/browser/admin-panels.html';
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/admin-panels';
await mkdir(out, { recursive: true });

const notes = [];
let cases = 0;
const check = async (name, fn) => {
  cases += 1;
  await fn();
  notes.push(`ok   ${name}`);
  console.log(`ok   ${name}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });

/** A render throw reaches the console too; collect it for the failure message. */
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-panel="kyc"]');

await check('AdminKyc mounts without throwing', async () => {
  const threw = await page.getAttribute('[data-panel="kyc"]', 'data-threw');
  assert.equal(
    threw,
    '',
    `the KYC panel threw on mount: ${threw}\nconsole:\n${consoleErrors.join('\n')}`
  );
});

await check('it renders its own chrome, not an empty box', async () => {
  // The panel's tabs and its queue are the proof it got past the first render
  // rather than merely failing silently.
  const text = (await page.textContent('[data-panel="kyc"]')) ?? '';
  assert.ok(text.length > 40, `the panel rendered almost nothing: ${JSON.stringify(text)}`);
  const buttons = await page.$$eval('[data-panel="kyc"] button', (els) => els.length);
  assert.ok(buttons >= 2, `expected the tab controls, found ${buttons} buttons`);
});

await check('the case window is CLOSED on first paint, and its body is not built', async () => {
  // The bug was the body being evaluated while closed. The window must not be
  // in the document at all until a case is opened — that is what the guard
  // buys, over and above not throwing.
  assert.equal(await page.$('[data-overlay="kyc-case-detail"]'), null);
});

await check('nothing was swallowed: no render error reached the console', async () => {
  const fatal = consoleErrors.filter(
    (e) => /Cannot read propert|is not a function|undefined is not/.test(e)
  );
  assert.deepEqual(fatal, [], `render errors on mount:\n${fatal.join('\n')}`);
});

await page.screenshot({ path: `${out}/kyc.png`, fullPage: true });
await browser.close();

await writeFile(`${out}/proof.txt`, notes.join('\n') + '\n');
console.log(`\n${cases} checks passed. Screenshot and notes in ${out}`);
