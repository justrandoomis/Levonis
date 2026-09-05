#!/usr/bin/env node
/**
 * Security headers and Content-Security-Policy on a running deployment.
 *
 * Two proofs, both read-only (anonymous GETs, no cookie, nothing written):
 *
 *  1. HEADERS. The document, an SPA route, a built asset and an API response
 *     must all carry Content-Security-Policy, Strict-Transport-Security,
 *     X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy
 *     and Permissions-Policy — and the policy's script-src must allow neither
 *     inline script nor eval. The document is served by the asset layer
 *     (dist/_headers), the API by the Worker (lib/http.ts): the two are
 *     generated from one module and this is where that is proven live.
 *
 *  2. THE POLICY BREAKS NOTHING. A real Chromium opens the public pages with
 *     the policy enforced and the console is watched for "Refused to …" /
 *     "Content Security Policy" reports. One violation fails the run; a page
 *     that renders no text fails the run.
 *
 *   BASE_URL=https://levonis-iq.com node scripts/e2e-security-headers.mjs
 */
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require2('playwright')); }
catch { ({ chromium } = require2('/opt/node22/lib/node_modules/playwright/index.js')); }

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const PAGES = ['/', '/auth', '/products', '/community', '/warranty', '/cart'];

let passed = 0, failed = 0; const failures = [];
const check = (l, ok, d = '') => {
  if (ok) { passed++; console.log(`  ok   ${l}`); }
  else { failed++; failures.push(`${l}${d ? ` — ${d}` : ''}`); console.log(`  FAIL ${l}${d ? ` — ${d}` : ''}`); }
};

const REQUIRED = {
  'content-security-policy': null,
  'strict-transport-security': /max-age=\d+/,
  'x-frame-options': /^DENY$/i,
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /strict-origin-when-cross-origin/,
  'permissions-policy': /geolocation=\(\)/,
};

function scriptSrc(csp) {
  const part = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src '));
  return part ? part.slice('script-src '.length).split(/\s+/) : null;
}

async function headersOf(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', headers: { Accept: 'text/html,*/*' } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function main() {
  console.log(`\nSECURITY HEADERS suite — ${BASE}\n`);

  console.log('1. every kind of response carries the headers');
  const home = await headersOf('/');
  const asset = (home.text.match(/\/assets\/[A-Za-z0-9_.-]+\.js/) || [])[0];
  const targets = ['/', '/auth', '/products', '/api/health', ...(asset ? [asset] : [])];
  check('the document names a built module', !!asset, 'no /assets/*.js in the HTML');
  let csp = null;
  for (const t of targets) {
    const r = t === '/' ? home : await headersOf(t);
    check(`${t} answers 200`, r.status === 200, `status ${r.status}`);
    for (const [name, re] of Object.entries(REQUIRED)) {
      const v = r.headers.get(name);
      check(`${t} carries ${name}`, !!v && (!re || re.test(v)), v ? `was "${v.slice(0, 60)}"` : 'missing');
    }
    const c = r.headers.get('content-security-policy');
    if (c) {
      if (!csp) csp = c;
      else check(`${t} carries the SAME policy text as the document`, c === csp, 'differs');
      const src = scriptSrc(c) || [];
      check(`${t} script-src refuses inline script`, !src.includes("'unsafe-inline'"));
      check(`${t} script-src refuses eval`, !src.includes("'unsafe-eval'"));
      check(`${t} script-src allows the app and Google sign-in only`, src.length === 2 && src.includes("'self'") && src.includes('https://accounts.google.com'), src.join(' '));
      check(`${t} cannot be framed (frame-ancestors 'none')`, /frame-ancestors 'none'/.test(c));
    }
  }
  if (csp) console.log(`\n  policy: ${csp}\n`);

  console.log('2. the policy is enforced and breaks nothing a visitor sees');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ar-IQ' });
  const page = await ctx.newPage();
  const violations = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect|frame|display)/i.test(t)) violations.push(`${page.url()} :: ${t.slice(0, 200)}`);
  });
  for (const p of PAGES) {
    const before = violations.length;
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const text = (await page.locator('body').innerText().catch(() => '')) || '';
    check(`${p} renders under the policy`, text.trim().length > 40, `${text.trim().length} chars of text`);
    check(`${p} raises no policy violation`, violations.length === before, violations.slice(before).join(' | '));
  }
  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
