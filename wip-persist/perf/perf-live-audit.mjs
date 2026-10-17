#!/usr/bin/env node
/**
 * THE LIVE SPEED AUDIT — the public site as a phone in Iraq loads it, measured
 * on the real site with real data (scripts/perf-lab.mjs measures a local build
 * whose /api answers nothing). Read-only: anonymous GETs of public pages, the
 * same requests any visitor makes. No cookie, no session, no form, no write.
 *
 * Two profiles, a COLD browser context per visit (no HTTP cache, no service
 * worker, no storage):
 *   phone   — 360×800, devicePixelRatio 3, touch, CPU ×4, Slow-4G
 *             (150 ms RTT, 1.6 Mbps down, 750 kbps up);
 *   desktop — 1366×768, devicePixelRatio 1, no throttling (raw bytes).
 *
 * Per visit it records, from the DevTools protocol, every request (URL, kind,
 * status, wire bytes, start and end, cache headers), and from the page: FCP,
 * the last LCP candidate (element and URL), CLS, long tasks, every <img> (the
 * file it loaded, its natural size, the box it is drawn in, loading/fetchpriority
 * attributes, whether it was in the first screen), the product links on the
 * page, and what a scroll to the bottom fetches afterwards (lazy loading and
 * paging, or everything up front).
 *
 *   AUDIT_BASE=https://levonis-iq.com PLAYWRIGHT_MODULE=… node scripts/perf-live-audit.mjs
 *
 * Env: AUDIT_BASE (default https://levonis-iq.com), AUDIT_ROUTES (comma list;
 * default: the home, /products, /categories, the first category and listing
 * and product the home links to, /community), AUDIT_RUNS (visits per route and
 * profile, default 2), AUDIT_OUT (JSON path, default perf-live-audit.json),
 * PLAYWRIGHT_MODULE (path of an isolated playwright install).
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = (process.env.AUDIT_BASE || 'https://levonis-iq.com').replace(/\/$/, '');
const RUNS = Math.max(1, Number(process.env.AUDIT_RUNS) || 2);
const OUT = process.env.AUDIT_OUT || 'perf-live-audit.json';
const SETTLE_MS = 6000;

const PROFILES = {
  phone: {
    context: {
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      locale: 'ar-IQ',
    },
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpu: 4,
  },
  desktop: {
    context: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, locale: 'ar-IQ' },
    network: null,
    cpu: 1,
  },
};

const OBSERVERS = () => {
  const w = window;
  w.__audit = { fcp: null, lcp: null, cls: 0, longTasks: 0, longTaskMs: 0 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') w.__audit.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const el = e.element;
        w.__audit.lcp = {
          t: e.startTime,
          size: e.size,
          url: e.url || '',
          tag: el ? el.tagName.toLowerCase() : '',
          text: el && !e.url ? (el.textContent || '').trim().slice(0, 60) : '',
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) w.__audit.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        w.__audit.longTasks += 1;
        w.__audit.longTaskMs += e.duration;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* an engine without one observer still reports the others */
  }
};

const kindOf = (type, url, mime) => {
  const u = new URL(url);
  if (u.pathname.startsWith('/api/')) return 'api';
  if (type === 'Image' || /^image\//.test(mime || '')) return 'img';
  if (type === 'Media' || /^video\//.test(mime || '')) return 'media';
  if (type === 'Script') return 'js';
  if (type === 'Stylesheet') return 'css';
  if (type === 'Font') return 'font';
  if (type === 'Document') return 'doc';
  return 'other';
};

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return (u.origin === BASE ? '' : u.host) + u.pathname + (u.search.length > 60 ? u.search.slice(0, 60) + '…' : u.search);
  } catch {
    return url.slice(0, 100);
  }
};

/** Arrays of objects carrying a slug or id, the longest one — "how many products did this answer carry". */
function itemCount(json) {
  let best = 0;
  const walk = (v, depth) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object' && v[0] && ('slug' in v[0] || 'id' in v[0])) best = Math.max(best, v.length);
      for (const x of v.slice(0, 3)) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(json, 0);
  return best;
}

async function visit(browser, profileName, path) {
  const profile = PROFILES[profileName];
  const context = await browser.newContext({ ...profile.context, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(OBSERVERS);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  if (profile.network) await cdp.send('Network.emulateNetworkConditions', profile.network);
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });

  const reqs = new Map();
  let t0 = null;
  let phase = 'load';
  cdp.on('Network.requestWillBeSent', (e) => {
    if (t0 === null) t0 = e.timestamp;
    if (!reqs.has(e.requestId))
      reqs.set(e.requestId, { url: e.request.url, type: e.type, start: (e.timestamp - t0) * 1000, phase, priority: e.request.initialPriority });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    const h = Object.fromEntries(Object.entries(e.response.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    r.status = e.response.status;
    r.mime = e.response.mimeType;
    r.cache = h['cache-control'] || '';
    r.cf = h['cf-cache-status'] || '';
    r.variant = h['x-variant-source'] || '';
    r.ttfb = e.response.timing ? e.response.timing.receiveHeadersEnd : null;
    r.type = e.type || r.type;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.bytes = e.encodedDataLength;
    r.end = (e.timestamp - t0) * 1000;
    if (r.url.includes('/api/') && (r.mime || '').includes('json')) {
      r.pendingBody = cdp
        .send('Network.getResponseBody', { requestId: e.requestId })
        .then((b) => {
          const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
          r.bodyBytes = Buffer.byteLength(text);
          try {
            r.items = itemCount(JSON.parse(text));
          } catch {
            r.items = null;
          }
        })
        .catch(() => {});
    }
  });
  cdp.on('Network.loadingFailed', (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.failed = e.errorText;
      r.end = (e.timestamp - t0) * 1000;
    }
  });

  let navError = '';
  const started = Date.now();
  try {
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 120000 });
  } catch (err) {
    navError = String(err.message || err).split('\n')[0];
  }
  const loadMs = Date.now() - started;
  await page.waitForTimeout(SETTLE_MS);

  const dom = await page
    .evaluate(() => {
      const vh = innerHeight;
      const imgs = [...document.images].map((im) => {
        const r = im.getBoundingClientRect();
        return {
          src: im.currentSrc || im.src,
          nw: im.naturalWidth,
          nh: im.naturalHeight,
          w: Math.round(r.width),
          h: Math.round(r.height),
          top: Math.round(r.top + scrollY),
          firstScreen: r.top < vh && r.bottom > 0,
          loading: im.loading || '',
          fp: im.getAttribute('fetchpriority') || '',
          srcset: !!im.getAttribute('srcset'),
          sizes: im.getAttribute('sizes') || '',
          complete: im.complete,
        };
      });
      const links = new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^\/product\//.test(h || '')));
      const cats = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^\/categories\/[^/?#]+(\/[^/?#]+)?$/.test(h || '')))];
      const videos = [...document.querySelectorAll('video')].map((v) => ({ preload: v.preload, autoplay: v.autoplay, src: v.currentSrc }));
      return { imgs, productLinks: [...links], cats, videos, dpr: devicePixelRatio, docHeight: document.documentElement.scrollHeight, audit: window.__audit, nav: performance.getEntriesByType('navigation')[0]?.toJSON?.() };
    })
    .catch((err) => ({ error: String(err) }));

  const beforeScroll = reqs.size;
  phase = 'scroll';
  // Scroll to the bottom in screens, as a reader would, and see what that fetches.
  for (let i = 0; i < 14; i++) {
    const more = await page.evaluate(() => {
      scrollBy(0, innerHeight * 0.9);
      return scrollY + innerHeight < document.documentElement.scrollHeight - 4;
    }).catch(() => false);
    await page.waitForTimeout(700);
    if (!more) break;
  }
  await page.waitForTimeout(2500);
  const afterScrollLinks = await page
    .evaluate(() => new Set([...document.querySelectorAll('a[href^="/product/"]')].map((a) => a.getAttribute('href'))).size)
    .catch(() => null);
  await Promise.all([...reqs.values()].map((r) => r.pendingBody).filter(Boolean));
  await context.close();

  const list = [...reqs.values()].map((r) => ({ ...r, kind: kindOf(r.type, r.url, r.mime), pendingBody: undefined }));
  return { profile: profileName, path, navError, loadMs, dom, requests: list, beforeScroll, afterScrollLinks };
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const kb = (b) => (b == null ? '—' : `${(b / 1024).toFixed(1)}KB`);
const ms = (t) => (t == null ? '—' : `${Math.round(t)}ms`);

function summarize(v) {
  const load = v.requests.filter((r) => r.phase === 'load');
  const scroll = v.requests.filter((r) => r.phase === 'scroll');
  const byKind = {};
  for (const r of load) {
    const k = (byKind[r.kind] ||= { n: 0, bytes: 0 });
    k.n += 1;
    k.bytes += r.bytes || 0;
  }
  const lcp = v.dom.audit?.lcp?.t ?? null;
  const beforeLcp = load.filter((r) => lcp != null && r.start <= lcp);
  const dpr = v.dom.dpr || 1;
  // An image is over-fetched when its file is much wider than the box × DPR it is drawn in.
  const imgReq = new Map(v.requests.filter((r) => r.kind === 'img').map((r) => [r.url, r]));
  const imgs = (v.dom.imgs || []).map((im) => {
    const r = imgReq.get(im.src);
    const need = Math.max(1, im.w * dpr);
    return { ...im, bytes: r?.bytes ?? null, phase: r?.phase ?? null, variant: r?.variant ?? '', cf: r?.cf ?? '', over: im.nw && im.w ? +(im.nw / need).toFixed(2) : null };
  });
  const overfetched = imgs.filter((im) => im.over != null && im.over > 1.6 && (im.bytes || 0) > 20 * 1024);
  const offscreenEager = imgs.filter((im) => !im.firstScreen && im.loading !== 'lazy' && im.phase === 'load');
  const apis = v.requests
    .filter((r) => r.kind === 'api')
    .map((r) => ({ url: shortUrl(r.url), status: r.status, bytes: r.bytes, body: r.bodyBytes, items: r.items, ms: r.end != null ? r.end - r.start : null, start: r.start, cf: r.cf, cache: r.cache, phase: r.phase }));
  const doc = v.requests.find((r) => r.kind === 'doc');
  return {
    path: v.path,
    profile: v.profile,
    navError: v.navError,
    ttfb: v.dom.nav?.responseStart ?? doc?.ttfb ?? null,
    fcp: v.dom.audit?.fcp ?? null,
    lcp,
    lcpEl: v.dom.audit?.lcp ? `${v.dom.audit.lcp.tag}${v.dom.audit.lcp.url ? ' ' + shortUrl(v.dom.audit.lcp.url) : ' "' + v.dom.audit.lcp.text + '"'}` : '',
    cls: v.dom.audit?.cls ?? null,
    longTasks: v.dom.audit ? `${v.dom.audit.longTasks}/${Math.round(v.dom.audit.longTaskMs)}ms` : '',
    loadMs: v.loadMs,
    reqLoad: load.length,
    bytesLoad: load.reduce((s, r) => s + (r.bytes || 0), 0),
    byKind,
    beforeLcp: { n: beforeLcp.length, bytes: beforeLcp.reduce((s, r) => s + (r.bytes || 0), 0) },
    reqScroll: scroll.length,
    bytesScroll: scroll.reduce((s, r) => s + (r.bytes || 0), 0),
    imgScroll: scroll.filter((r) => r.kind === 'img').length,
    productLinks: v.dom.productLinks?.length ?? 0,
    productLinksAfterScroll: v.afterScrollLinks,
    imgCount: imgs.length,
    imgFirstScreen: imgs.filter((i) => i.firstScreen).length,
    offscreenEager: offscreenEager.length,
    overfetched,
    largest: [...v.requests].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 12).map((r) => ({ url: shortUrl(r.url), kind: r.kind, bytes: r.bytes, phase: r.phase, cf: r.cf, variant: r.variant, ms: r.end != null ? Math.round(r.end - r.start) : null })),
    apis,
    videos: v.dom.videos || [],
    docCache: doc ? { cache: doc.cache, cf: doc.cf } : null,
    failed: v.requests.filter((r) => r.failed || (r.status && r.status >= 400)).map((r) => `${r.status || r.failed} ${shortUrl(r.url)}`).slice(0, 10),
  };
}

async function discover(browser) {
  const v = await visit(browser, 'desktop', '/');
  const links = v.dom.productLinks || [];
  const cats = v.dom.cats || [];
  const top = cats.find((c) => c.split('/').length === 3);
  const sub = cats.find((c) => c.split('/').length === 4);
  return { product: links[0] || null, category: top || null, listing: sub || null, home: v };
}

const browser = await chromium.launch();
const found = await discover(browser);
const routes = process.env.AUDIT_ROUTES
  ? process.env.AUDIT_ROUTES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['/', '/products', '/categories', found.category, found.listing, found.product, '/community'].filter(Boolean);
console.log(`base ${BASE}; routes: ${routes.join(' ')}; runs ${RUNS}; discovered product ${found.product}, category ${found.category}, listing ${found.listing}`);

const results = [];
for (const path of routes) {
  for (const profile of ['phone', 'desktop']) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(summarize(await visit(browser, profile, path)));
    results.push({ path, profile, runs });
  }
}
await browser.close();
writeFileSync(OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 1));

// The report: medians per route and profile, then the evidence of the first phone run.
console.log('\n== MEDIANS (cold) ==');
console.log('route | profile | TTFB | FCP | LCP | CLS | load | req@load | KB@load | js | css | font | img | api | scroll req/img/KB | products initial→after scroll');
for (const r of results) {
  const m = (f) => median(r.runs.map(f));
  const k = (kind) => kb(m((x) => x.byKind[kind]?.bytes ?? 0));
  console.log(
    [r.path, r.profile, ms(m((x) => x.ttfb)), ms(m((x) => x.fcp)), ms(m((x) => x.lcp)), (m((x) => x.cls) ?? 0).toFixed(3), ms(m((x) => x.loadMs)), m((x) => x.reqLoad), kb(m((x) => x.bytesLoad)), k('js'), k('css'), k('font'), k('img'), k('api'), `${m((x) => x.reqScroll)}/${m((x) => x.imgScroll)}/${kb(m((x) => x.bytesScroll))}`, `${m((x) => x.productLinks)}→${m((x) => x.productLinksAfterScroll)}`].join(' | ')
  );
}
for (const r of results) {
  const x = r.runs[0];
  console.log(`\n== ${r.path} [${r.profile}] run 1 ==${x.navError ? ' NAV ERROR: ' + x.navError : ''}`);
  console.log(`LCP ${ms(x.lcp)} on ${x.lcpEl}; before LCP: ${x.beforeLcp.n} requests ${kb(x.beforeLcp.bytes)}; long tasks ${x.longTasks}; doc cache "${x.docCache?.cache}" cf=${x.docCache?.cf}`);
  console.log(`images: ${x.imgCount} in DOM, ${x.imgFirstScreen} in the first screen, ${x.offscreenEager} below the fold loaded eagerly at load; ${x.imgScroll} more fetched on scroll`);
  for (const im of x.overfetched.slice(0, 8))
    console.log(`  OVERFETCH x${im.over}: ${shortUrl(im.src)} file ${im.nw}x${im.nh} ${kb(im.bytes)} drawn ${im.w}x${im.h} (${im.firstScreen ? 'first screen' : 'below'}, loading=${im.loading || 'eager'}, srcset=${im.srcset}, variant=${im.variant || '-'})`);
  for (const a of x.apis.slice(0, 14))
    console.log(`  API ${a.phase} ${a.status} ${a.url} wire ${kb(a.bytes)} json ${kb(a.body)} items ${a.items ?? '-'} ${ms(a.ms)} start ${ms(a.start)} cf=${a.cf} cache="${a.cache}"`);
  for (const l of x.largest.slice(0, 8)) console.log(`  BIG ${l.kind} ${kb(l.bytes)} ${l.url} (${l.phase}, ${ms(l.ms)}, cf=${l.cf}${l.variant ? ', variant=' + l.variant : ''})`);
  if (x.videos.length) console.log(`  videos: ${x.videos.map((v) => `preload=${v.preload} autoplay=${v.autoplay}`).join('; ')}`);
  if (x.failed.length) console.log(`  failed: ${x.failed.join('; ')}`);
}
