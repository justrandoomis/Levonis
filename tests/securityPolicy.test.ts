/**
 * The browser-side lock: Content-Security-Policy and HSTS.
 *
 * The same SPA bundle answers the apex and every merchant subdomain, with one
 * parent-domain cookie. React escapes what merchants type; this policy is what
 * holds if that ever fails — so the tests are written as "what would an
 * injected script be allowed to do", not as a string comparison.
 *
 * The print documents carry their own policy naming their one inline script
 * by hash. The hash and the script are pinned together here so neither can
 * change without the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { securityHeaders } from '../worker/lib/http';
import {
  AUTO_PRINT_SCRIPT,
  AUTO_PRINT_SCRIPT_HASH,
  CLOUDFLARE_INSIGHTS_BEACON,
  CLOUDFLARE_INSIGHTS_SCRIPT,
  GOOGLE_SIGNIN_ORIGIN,
  STATIC_SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
  asDocument,
  assetHeadersFile,
  documentCsp,
  spaCsp,
} from '../worker/lib/securityPolicy';
import { renderWarrantyDoc, type WarrantyDocData } from '../worker/lib/warrantyDoc';
import { renderPurchaseReceipt, type PurchaseReceiptData } from '../worker/lib/receipts';
import { DEFAULT_WARRANTY_CONFIG } from '../worker/lib/warrantyConfig';

/** The source list of one directive, or null when the policy does not set it. */
function directive(csp: string, name: string): string[] | null {
  const part = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s === name || s.startsWith(name + ' '));
  if (part === undefined) return null;
  return part.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

const ROOT = 'levonis-iq.com';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------ the SPA policy

test('an injected inline or eval script is refused — the lock that holds when escaping fails', () => {
  const script = directive(spaCsp(), 'script-src');
  assert.ok(script, 'script-src is set');
  assert.ok(!script.includes("'unsafe-inline'"), 'no inline script');
  assert.ok(!script.includes("'unsafe-eval'"), 'no eval');
  assert.ok(!script.includes('*') && !script.includes('https:'), 'no wildcard script origin');
  assert.deepEqual(script, ["'self'", GOOGLE_SIGNIN_ORIGIN, CLOUDFLARE_INSIGHTS_SCRIPT]);
});

test("Cloudflare's edge-injected analytics beacon may load and report — found refused by the first live run", () => {
  // Nothing in the repository loads beacon.min.js: the zone's Web Analytics
  // setting makes the edge inject it into every HTML response. Refusing it
  // (as the first policy did) silently blinded the owner's analytics.
  const csp = spaCsp();
  assert.ok(directive(csp, 'script-src')?.includes(CLOUDFLARE_INSIGHTS_SCRIPT), 'the script may load');
  assert.ok(directive(csp, 'connect-src')?.includes(CLOUDFLARE_INSIGHTS_BEACON), 'the beacon may report');
  // …and the allowance is exactly those two origins — never a Cloudflare wildcard.
  assert.equal(CLOUDFLARE_INSIGHTS_SCRIPT, 'https://static.cloudflareinsights.com');
  assert.equal(CLOUDFLARE_INSIGHTS_BEACON, 'https://cloudflareinsights.com');
  assert.ok(!csp.includes('*.cloudflare'), 'no wildcard');
});

test('Google sign-in keeps working: its origin may load, frame and connect', () => {
  const csp = spaCsp();
  for (const name of ['script-src', 'frame-src', 'connect-src']) {
    assert.ok(directive(csp, name)?.includes(GOOGLE_SIGNIN_ORIGIN), name);
  }
});

test('product media may come from any HTTPS vendor CDN; previews from blob: and data:', () => {
  const csp = spaCsp();
  const img = directive(csp, 'img-src') ?? [];
  for (const s of ['https:', 'data:', 'blob:', "'self'"]) assert.ok(img.includes(s), `img-src ${s}`);
  assert.ok(directive(csp, 'media-src')?.includes('https:'), 'media-src https:');
  assert.ok(!img.includes('http:'), 'never plain http');
});

test('the page cannot be framed, re-based, made to submit elsewhere or host plugins', () => {
  const csp = spaCsp();
  assert.deepEqual(directive(csp, 'frame-ancestors'), ["'none'"]);
  assert.deepEqual(directive(csp, 'base-uri'), ["'self'"]);
  assert.deepEqual(directive(csp, 'form-action'), ["'self'"]);
  assert.deepEqual(directive(csp, 'object-src'), ["'none'"]);
});

test('the app talks only to itself (plus Google sign-in, the fonts stylesheet and the analytics beacon)', () => {
  assert.deepEqual(directive(spaCsp(), 'connect-src'), [
    "'self'", 'blob:', GOOGLE_SIGNIN_ORIGIN, 'https://fonts.googleapis.com', CLOUDFLARE_INSIGHTS_BEACON,
  ]);
});

// ------------------------------------------------------ the document policy

test('the auto-print hook is the one inline script, and its hash is pinned to it', () => {
  const expected = createHash('sha256').update(AUTO_PRINT_SCRIPT, 'utf8').digest('base64');
  assert.equal(AUTO_PRINT_SCRIPT_HASH, `sha256-${expected}`);
  // Hash only — no 'self', no 'unsafe-inline': nothing but that script runs.
  assert.deepEqual(directive(documentCsp(), 'script-src'), [`'${AUTO_PRINT_SCRIPT_HASH}'`]);
  assert.deepEqual(directive(documentCsp(), 'frame-ancestors'), ["'none'"]);
});

const DOC: WarrantyDocData = {
  receipt_no: 'WR-2026-0902-001',
  issued_date: '2026-09-02T00:00:00.000Z',
  status: 'active',
  customer: { name: 'أسامة محمود', address: 'بغداد، أبو غريب', phone: '07802969048', email: '' },
  product: {
    description: 'Gigabyte GeForce RTX 5070 Ti AERO 16GB',
    model: '5070 Ti AERO 16GB',
    serial: 'SN-260601014148',
    price_iqd: 1_850_000,
    purchase_date: '2026-09-02T00:00:00.000Z',
    order_receipt_no: 'INV-2026-0902-001',
  },
  warranty: {
    months: 12,
    type: 'ضمان ليفونيس',
    coverage: 'يغطي عيوب التصنيع.',
    start_at: '2026-09-02T00:00:00.000Z',
    end_at: '2027-09-02T00:00:00.000Z',
  },
  terms: DEFAULT_WARRANTY_CONFIG.terms,
  retailer: DEFAULT_WARRANTY_CONFIG.retailer,
  verify_url: 'https://levonis-iq.com/warranty/WR-2026-0902-001',
  chain: { replaces: null, replaced_by: null },
};

const RECEIPT: PurchaseReceiptData = {
  order_id: 'ORD-ABC123',
  invoice_no: 'INV-0007',
  created_at: '2026-03-01T10:30:00.000Z',
  customer_name: 'أحمد الجبوري',
  phone: '07701234567',
  governorate: 'بغداد',
  area: 'الجادرية',
  address: 'شارع 62',
  landmark: '',
  notes: '',
  lines: [{ name: 'PLA Basic', variant: 'أسود', qty: 1, unit_iqd: 20_000, line_iqd: 20_000 }],
  adjustments: [],
  subtotal_iqd: 20_000,
  shipping_iqd: 5_000,
  total_iqd: 25_000,
  due_on_delivery_iqd: 25_000,
  payment_method: 'cash',
  shipping_type_label: 'شحن مباشر',
  support_code: '',
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

test('the documents emit exactly that script — so the hash matches what the browser sees', () => {
  for (const [name, html] of [
    ['warranty', renderWarrantyDoc(DOC, 'ar', true)],
    ['receipt', renderPurchaseReceipt(RECEIPT, 'ar', true)],
  ] as const) {
    assert.ok(html.includes(`<script>${AUTO_PRINT_SCRIPT}</script>`), `${name} carries the pinned script`);
    assert.equal(count(html, '<script'), 1, `${name}: one inline script, no other`);
  }
  assert.equal(count(renderWarrantyDoc(DOC, 'ar', false), '<script'), 0, 'no script unless printing');
  assert.equal(count(renderPurchaseReceipt(RECEIPT, 'ar', false), '<script'), 0);
});

// ------------------------------------------------- the middleware, end to end

function appWith(env: Record<string, string>) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = env as never;
    await next();
  });
  app.use('*', securityHeaders());
  app.get('/api/x', (c) => c.json({ ok: true }));
  app.get('/doc', (c) => {
    asDocument(c);
    return c.html('<!doctype html><p>x</p>');
  });
  app.get('/files/a.png', () =>
    new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } })
  );
  return app;
}

const PROD = { APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: ROOT };

test('every ordinary response carries the SPA policy and HSTS', async () => {
  const res = await appWith(PROD).request('https://levonis-iq.com/api/x');
  assert.equal(res.headers.get('Content-Security-Policy'), spaCsp());
  assert.equal(res.headers.get('Strict-Transport-Security'), STRICT_TRANSPORT_SECURITY);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
});

test('a route that chose its own policy keeps it: print documents and the R2 file sandbox', async () => {
  const app = appWith(PROD);
  const doc = await app.request('https://levonis-iq.com/doc');
  assert.equal(doc.headers.get('Content-Security-Policy'), documentCsp());
  const file = await app.request('https://levonis-iq.com/files/a.png');
  assert.equal(file.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  // HSTS is not a per-route choice; it is on those too.
  assert.equal(file.headers.get('Strict-Transport-Security'), STRICT_TRANSPORT_SECURITY);
});

test('HSTS names every subdomain and lasts a year, without a preload claim', () => {
  assert.match(STRICT_TRANSPORT_SECURITY, /max-age=31536000/);
  assert.match(STRICT_TRANSPORT_SECURITY, /includeSubDomains/);
  assert.doesNotMatch(STRICT_TRANSPORT_SECURITY, /preload/);
});

// ------------------------------------------- the page itself: dist/_headers

test('THE PAGE: the asset layer serves index.html, so the same policy is written to dist/_headers', async () => {
  // Found by the live probe, not by reading code: /api/* carried every header
  // and the SPA document carried none, because wrangler runs the Worker only
  // for /api/* and /files/* (run_worker_first) and the asset layer answers
  // the rest. The file below is what the asset layer applies.
  const file = assetHeadersFile();
  const lines = file.split('\n');
  assert.equal(lines.find((l) => !l.startsWith('#')), '/*', 'one rule, for every asset response');
  assert.ok(lines.includes(`  Content-Security-Policy: ${spaCsp()}`), 'the SAME policy text as the API');
  assert.ok(lines.includes(`  Strict-Transport-Security: ${STRICT_TRANSPORT_SECURITY}`));
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) assert.ok(lines.includes(`  ${k}: ${v}`), k);

  // …and the build actually writes it, on every build, AFTER vite — vite
  // empties dist/, so a headers file written before it would be deleted by the
  // build that was supposed to carry it. That ORDER is what this pins.
  //
  // It is deliberately not anchored to the end of the script any more: steps
  // that only READ dist/ may follow (check-live-markers.mjs verifies that the
  // strings the live verification greps for survived minification). A step
  // that WROTE to dist after this point would be the real hazard, and the
  // ordering assertion below is what would catch it moving.
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.build, /vite build && node scripts\/write-asset-headers\.mjs(\s|$|&)/);
  const steps = pkg.scripts.build.split('&&').map((x) => x.trim());
  assert.ok(
    steps.indexOf('vite build') < steps.indexOf('node scripts/write-asset-headers.mjs'),
    'the headers file must be written after vite empties dist/'
  );
  const wrangler = readFileSync('wrangler.jsonc', 'utf8');
  assert.match(wrangler, /"run_worker_first":\s*\["\/api\/\*",\s*"\/files\/\*"\]/,
    'if the Worker starts running first for pages, revisit whether _headers is still the right layer');
});

/**
 * A REFUSAL IS A RESPONSE, AND IT CARRIES THE HEADERS TOO.
 *
 * `gatewayAssertion` answers `403 NOT_VIA_GATEWAY` and never calls `next()`.
 * Hono composes in registration order, so a middleware registered BEFORE
 * `securityHeaders()` that short-circuits skips it entirely — CSP, HSTS and the
 * static headers absent on exactly the responses an attacker sees. The gateway's
 * own app puts security headers outermost for this reason, and
 * `worker/index.ts` now does the same; this test is what keeps the order.
 */
test('a short-circuiting middleware registered after securityHeaders still carries CSP and HSTS', async () => {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = PROD as never;
    await next();
  });
  app.use('*', securityHeaders());
  // stands in for `gatewayAssertion` at GATEWAY_ONLY=on
  app.use('*', async (c) => c.json({ success: false, error: 'Not via gateway', code: 'NOT_VIA_GATEWAY' }, 403));
  app.get('/api/x', (c) => c.json({ ok: true }));

  const res = await app.request('https://levonis-iq.com/api/x');
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Content-Security-Policy'), spaCsp());
  assert.equal(res.headers.get('Strict-Transport-Security'), STRICT_TRANSPORT_SECURITY);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('worker/index.ts registers securityHeaders() before gatewayAssertion', () => {
  const src = readFileSync(join(ROOT_DIR, 'worker', 'index.ts'), 'utf8');
  const headers = src.indexOf("app.use('*', securityHeaders())");
  const assertion = src.indexOf("app.use('*', gatewayAssertion)");
  assert.ok(headers > 0 && assertion > 0, 'both middlewares are registered');
  assert.ok(headers < assertion, 'securityHeaders() must be outermost, or a 403 NOT_VIA_GATEWAY carries no CSP');
});
