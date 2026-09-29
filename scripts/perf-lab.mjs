#!/usr/bin/env node
/**
 * THE PERFORMANCE LAB — the site as an Iraqi phone loads it, measured, not
 * guessed (docs/MERCHANT_PLATFORM_V2.md §B.4; results in docs/PERFORMANCE_LOG.md).
 *
 * Playwright Chromium, a 360×800 mobile context, CPU ×4, Slow-4G (150 ms RTT,
 * 1.6 Mbps down / 750 kbps up), a COLD cache for every run (a fresh browser
 * context per visit: no HTTP cache, no service worker, no storage). Each route
 * is visited N times (default 3) and the table reports the MEDIAN of every
 * number, so one slow run does not become the story.
 *
 *   npm run build
 *   npx vite preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node scripts/perf-lab.mjs --label P0-baseline
 *
 * Flags
 *   --base <url>       origin under test (default http://127.0.0.1:4173)
 *   --label <name>     the run's name; the JSON lands in scratchpad/perf/<label>.json
 *   --routes <a,b,c>   paths (or full URLs) to visit; default: the seven of §B.4
 *   --runs <n>         visits per route (default 3)
 *   --settle <ms>      how long to watch after `load` for the last LCP candidate
 *                      and late layout shifts (default 5000)
 *   --sw-repeat        after the cold table, a second table: one visit to let the
 *                      service worker install, then the SAME route again, measured
 *   --out <path>       where to write the JSON (overrides the label's default)
 *
 * WHAT IT MEASURES (per visit): TTFB and the document's transfer size from the
 * navigation entry; FCP from the paint observer; the LAST LCP candidate seen
 * before the settle window closed (element, text, URL); CLS without recent
 * input; long tasks (count, total ms) and TBT after FCP; the requests that
 * started before `load` and their wire bytes, by kind (js/css/font/img/api);
 * whether `/api/*` answered at all (a lab without the Worker renders every
 * route's no-API state — the numbers still compare build to build, but say
 * nothing about data-ready time, and the table says so).
 *
 * WHY `vite preview` OF A REAL `npm run build`: a bare `vite build` lacks
 * dist/_headers (immutable caching, CSP), which is what the deploy serves.
 * `vite preview` is HTTP/1.1 with gzip on the fly; production is HTTP/3 +
 * brotli, so absolute numbers are pessimistic by ~10 % and the deltas between
 * two builds are what count.
 *
 * A STORE HOST: `vite preview` accepts any `*.localhost` host, and Chromium
 * resolves those to loopback, so `--routes http://ali3d.localhost:4173/` visits
 * the storefront shell under a store host (its resolve call needs the Worker,
 * so in the SPA-only lab it renders the no-API state like every other route).
 *
 * PLAYWRIGHT: the repo does not depend on it. The script uses the local
 * `playwright` package when one is installed, else the one named by
 * PERF_PLAYWRIGHT or the sandbox's global install.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const DEFAULT_ROUTES = ['/', '/community', '/products', '/product/x', '/requests', '/auth', '/community/store/x'];

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:4173', label: '', routes: DEFAULT_ROUTES, runs: 3, settle: 5000, swRepeat: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') out.base = next();
    else if (a === '--label') out.label = next();
    else if (a === '--routes') out.routes = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--runs') out.runs = Math.max(1, Number(next()) || 3);
    else if (a === '--settle') out.settle = Math.max(0, Number(next()) || 5000);
    else if (a === '--sw-repeat') out.swRepeat = true;
    else if (a === '--out') out.out = next();
    else if (a === '--help' || a === '-h') { console.log('see the header of scripts/perf-lab.mjs'); process.exit(0); }
    else { console.error(`perf-lab: unknown flag ${a}`); process.exit(2); }
  }
  out.base = out.base.replace(/\/$/, '');
  if (!out.label) out.label = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (!out.out) out.out = resolve('scratchpad', 'perf', `${out.label}.json`);
  return out;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const require = createRequire(import.meta.url);
    const candidates = [process.env.PERF_PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright/index.js'].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return require(c);
    throw new Error('perf-lab: playwright not found — `npm i -D playwright` or set PERF_PLAYWRIGHT to its index.js');
  }
}

/** Observers installed before any script of the page runs. */
const INIT_SCRIPT = `(() => {
  const P = window.__perf = { lcp: [], cls: 0, shifts: [], longTasks: [], fcp: null };
  const on = (type, fn) => { try { new PerformanceObserver((l) => fn(l.getEntries())).observe({ type, buffered: true }); } catch (e) {} };
  on('largest-contentful-paint', (es) => { for (const e of es) { const el = e.element; P.lcp.push({ t: Math.round(e.startTime), size: e.size, url: e.url || null, tag: el ? el.tagName : null, text: el && el.textContent ? el.textContent.trim().slice(0, 50) : null }); } });
  on('layout-shift', (es) => { for (const e of es) if (!e.hadRecentInput) { P.cls += e.value; if (e.value > 0.01) P.shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4) }); } });
  on('longtask', (es) => { for (const e of es) P.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); });
  on('paint', (es) => { for (const e of es) if (e.name === 'first-contentful-paint') P.fcp = Math.round(e.startTime); });
})();`;

/** Read in the page after the settle window. */
const PAGE_EVAL = () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const P = window.__perf;
  const fcp = P.fcp || 0;
  const tbt = P.longTasks.filter((l) => l.t + l.d > fcp).reduce((a, l) => a + Math.max(0, l.d - 50), 0);
  const body = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    ttfb: nav ? Math.round(nav.responseStart) : null,
    docBytes: nav ? nav.transferSize : null,
    dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: P.fcp,
    lcp: P.lcp[P.lcp.length - 1] || null,
    cls: +P.cls.toFixed(4),
    shifts: P.shifts.slice(0, 5),
    longTasks: P.longTasks.length,
    longTaskMs: P.longTasks.reduce((a, l) => a + l.d, 0),
    tbt: Math.round(tbt),
    sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    title: document.title,
    bodyLen: body.length,
    errorish: /خطأ|تعذ|فشل|إعادة المحاولة|حاول مرة|Retry|Try again|Something went wrong|not found|غير موجود|لم نجد/i.test(body),
  };
};

function kind(url, type) {
  if (type === 'Document') return 'doc';
  if (type === 'Script' || /\.m?js(\?|$)/.test(url)) return 'js';
  if (type === 'Stylesheet' || /\.css(\?|$)/.test(url)) return 'css';
  if (type === 'Font' || /\.(woff2?|ttf|otf)(\?|$)/.test(url)) return 'font';
  if (type === 'Image' || /\.(png|jpe?g|webp|gif|svg|ico|avif)(\?|$)/.test(url)) return 'img';
  if (type === 'Fetch' || type === 'XHR' || /\/api\//.test(url)) return 'api';
  return 'other';
}

/** One visit of one URL in a fresh context. `warm` keeps the context (the repeat visit). */
async function visit(browser, url, opts, reuse) {
  const context = reuse?.context ?? await browser.newContext({
    viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-IQ',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  });
  const page = reuse?.page ?? await context.newPage();
  const cdp = reuse?.cdp ?? await context.newCDPSession(page);
  if (!reuse) {
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    await page.addInitScript(INIT_SCRIPT);
  }
  const reqs = new Map();
  let docStart = null;
  const onSent = (e) => { if (docStart === null && e.type === 'Document') docStart = e.timestamp; reqs.set(e.requestId, { url: e.request.url, type: e.type, start: e.timestamp }); };
  const onResp = (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.fromSW = !!e.response.fromServiceWorker; r.fromCache = !!e.response.fromDiskCache; } };
  const onDone = (e) => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.end = e.timestamp; } };
  const onFail = (e) => { const r = reqs.get(e.requestId); if (r) { r.failed = e.errorText; r.end = e.timestamp; } };
  cdp.on('Network.requestWillBeSent', onSent);
  cdp.on('Network.responseReceived', onResp);
  cdp.on('Network.loadingFinished', onDone);
  cdp.on('Network.loadingFailed', onFail);
  const pageErrors = [];
  const onPageError = (e) => pageErrors.push(String(e.message).slice(0, 120));
  page.on('pageerror', onPageError);

  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  } catch (e) {
    navError = String(e.message).slice(0, 160);
  }
  await page.waitForTimeout(opts.settle);
  const m = await page.evaluate(PAGE_EVAL);
  const loadMs = m.load ?? Infinity;
  const list = [...reqs.values()].map((r) => ({
    url: r.url, kind: kind(r.url, r.type), bytes: r.bytes || 0, status: r.status ?? null, fromSW: !!r.fromSW, fromCache: !!r.fromCache, failed: r.failed || null,
    t: docStart != null ? Math.round((r.start - docStart) * 1000) : null,
  }));
  const beforeLoad = list.filter((r) => r.t !== null && r.t <= loadMs);
  const byKind = {};
  for (const r of beforeLoad) { byKind[r.kind] = byKind[r.kind] || { n: 0, bytes: 0 }; byKind[r.kind].n++; byKind[r.kind].bytes += r.bytes; }
  const api = list.filter((r) => r.kind === 'api');
  const apiFailed = api.filter((r) => r.failed || (r.status ?? 0) >= 500).length;

  cdp.off('Network.requestWillBeSent', onSent);
  cdp.off('Network.responseReceived', onResp);
  cdp.off('Network.loadingFinished', onDone);
  cdp.off('Network.loadingFailed', onFail);
  page.off('pageerror', onPageError);

  const result = {
    url, navError, pageErrors: pageErrors.slice(0, 5), ...m,
    requests: beforeLoad.length, bytes: beforeLoad.reduce((a, r) => a + r.bytes, 0), byKind,
    requestsSettled: list.length, bytesSettled: list.reduce((a, r) => a + r.bytes, 0),
    fromSW: list.filter((r) => r.fromSW).length,
    api: { n: api.length, failed: apiFailed },
  };
  return { result, handles: { context, page, cdp } };
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

/** The median of every numeric field; the LCP element from the run whose LCP is the median. */
function summarise(runs) {
  const num = (k) => median(runs.map((r) => r[k]));
  const lcpT = median(runs.map((r) => r.lcp?.t ?? null));
  const lcpRun = runs.find((r) => r.lcp?.t === lcpT) ?? runs[0];
  return {
    runs: runs.length,
    ttfb: num('ttfb'), fcp: num('fcp'), lcp: lcpT, lcpElement: lcpRun?.lcp ?? null,
    cls: median(runs.map((r) => Math.round(r.cls * 1000))) / 1000,
    tbt: num('tbt'), longTasks: num('longTasks'), longTaskMs: num('longTaskMs'),
    requests: num('requests'), bytes: num('bytes'), docBytes: num('docBytes'), load: num('load'),
    fromSW: num('fromSW'),
    api: { n: median(runs.map((r) => r.api.n)), failed: median(runs.map((r) => r.api.failed)) },
    errorish: runs.filter((r) => r.errorish).length,
    navErrors: runs.filter((r) => r.navError).map((r) => r.navError),
    pageErrors: [...new Set(runs.flatMap((r) => r.pageErrors))].slice(0, 5),
  };
}

const kb = (n) => (n == null ? '—' : (n / 1024).toFixed(1));
const ms = (n) => (n == null ? '—' : String(n));
const lcpLabel = (e) => {
  if (!e) return '—';
  const what = e.url ? `${e.tag} ${e.url.replace(/^https?:\/\/[^/]+/, '').slice(-30)}` : `${e.tag} «${(e.text || '').slice(0, 24)}»`;
  return what.replace(/\|/g, '/');
};

function table(rows, { repeat = false } = {}) {
  const head = repeat
    ? '| route | TTFB | FCP | LCP | CLS | TBT | req @load (from SW) | KB @load | note |'
    : '| route | TTFB | FCP | LCP (element) | CLS | TBT | long tasks (n / ms) | req @load | KB @load (wire) | note |';
  const sep = head.replace(/[^|]+/g, (s) => '-'.repeat(Math.max(3, s.length)));
  const lines = [head, sep];
  for (const r of rows) {
    const s = r.summary;
    const note = [
      s.api.n ? (s.api.failed ? `API 500 ×${s.api.failed}` : `API ok ×${s.api.n}`) : 'no API call',
      s.errorish ? 'no-API state' : '',
      s.navErrors.length ? `nav error ×${s.navErrors.length}` : '',
      s.pageErrors.length ? `js error` : '',
    ].filter(Boolean).join(', ');
    if (repeat) {
      lines.push(`| \`${r.route}\` | ${ms(s.ttfb)} | ${ms(s.fcp)} | ${ms(s.lcp)} | ${s.cls} | ${ms(s.tbt)} | ${s.requests} (${s.fromSW}) | ${kb(s.bytes)} | ${note} |`);
    } else {
      lines.push(`| \`${r.route}\` | ${ms(s.ttfb)} | ${ms(s.fcp)} | ${ms(s.lcp)} (${lcpLabel(s.lcpElement)}) | ${s.cls} | ${ms(s.tbt)} | ${s.longTasks} / ${s.longTaskMs} | ${s.requests} | ${kb(s.bytes)} | ${note} |`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const started = new Date().toISOString();
  const cold = [];
  const warm = [];
  try {
    for (const route of opts.routes) {
      const url = /^https?:\/\//.test(route) ? route : opts.base + route;
      const runs = [];
      for (let i = 0; i < opts.runs; i++) {
        const { result, handles } = await visit(browser, url, opts);
        runs.push(result);
        await handles.context.close();
        console.error(`perf-lab: ${route} run ${i + 1}/${opts.runs} — FCP ${result.fcp} LCP ${result.lcp?.t ?? '—'} CLS ${result.cls}`);
      }
      cold.push({ route, url, runs, summary: summarise(runs) });

      if (opts.swRepeat) {
        const repeats = [];
        for (let i = 0; i < opts.runs; i++) {
          // Visit once to let the service worker install (it registers after
          // `load` in production builds), then the same route again.
          const first = await visit(browser, url, opts);
          const { page, context } = first.handles;
          // An active registration, or 20 s: without a service worker (a dev
          // build) the repeat is a plain HTTP-cache repeat and the table's
          // «from SW» column says 0.
          await page.waitForFunction(
            () => navigator.serviceWorker?.getRegistration().then((r) => !!r?.active),
            null, { timeout: 20_000, polling: 500 },
          ).catch(() => {});
          await page.waitForTimeout(1500);
          const second = await visit(browser, url, opts, first.handles);
          repeats.push(second.result);
          await context.close();
          console.error(`perf-lab: ${route} repeat ${i + 1}/${opts.runs} — FCP ${second.result.fcp} LCP ${second.result.lcp?.t ?? '—'} fromSW ${second.result.fromSW}`);
        }
        warm.push({ route, url, runs: repeats, summary: summarise(repeats) });
      }
    }
  } finally {
    await browser.close();
  }

  const out = {
    label: opts.label, base: opts.base, started, finished: new Date().toISOString(),
    lab: { viewport: '360x800', cpu: 4, network: 'Slow-4G 150ms/1.6Mbps/750kbps', runs: opts.runs, settleMs: opts.settle, cache: 'cold (fresh context per run)' },
    cold, repeat: warm,
  };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(out, null, 1));

  console.log(`\n### ${opts.label} — cold, median of ${opts.runs} (${opts.base}; 360×800, CPU ×4, Slow-4G)\n`);
  console.log(table(cold));
  if (warm.length) {
    console.log(`\n### ${opts.label} — repeat visit with the service worker, median of ${opts.runs}\n`);
    console.log(table(warm, { repeat: true }));
  }
  console.log(`\nJSON: ${opts.out}`);
}

main().catch((e) => { console.error('perf-lab:', e); process.exit(1); });
