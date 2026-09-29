#!/usr/bin/env node
/**
 * PAGESPEED INSIGHTS FOR THE LIVE SITE — the owner's «many tests», from the
 * terminal (docs/MERCHANT_PLATFORM_V2.md §B.4; results go to
 * docs/PERFORMANCE_LOG.md at every phase exit).
 *
 *   PSI_API_KEY=… npm run perf:psi                 # mobile, apex + one store host
 *   npm run perf:psi -- --store b                  # another store host
 *   npm run perf:psi -- --url https://levonis-iq.com/products
 *   npm run perf:psi -- --strategy desktop
 *
 * With PSI_API_KEY set (owner question Q6: a Google Cloud key with the
 * PageSpeed Insights API enabled) the script calls the v5 API for each URL and
 * prints one Markdown row per page: the performance score, the lab metrics
 * (FCP, LCP, CLS, TBT, Speed Index) and, when Chrome's field data exists for
 * the origin, the real-user p75 LCP / INP / CLS. Without the key it prints the
 * URLs to open by hand — the same numbers, one browser tab each.
 *
 * Flags
 *   --url <u[,u]>        pages to test (repeatable); default: apex + the store host
 *   --store <slug|host>  the store host (default PSI_STORE_HOST or ali3d.levonis-iq.com,
 *                        the host scripts/e2e-subdomains.mjs uses)
 *   --strategy mobile|desktop   (default mobile — the audience is phones)
 *   --json <path>        also write the raw API answers there
 *
 * The request carries only the public URL and the key; nothing of the site
 * leaves this process. Node's `fetch` does not read HTTPS_PROXY — behind a
 * proxy run with NODE_USE_ENV_PROXY=1 (Node 24+) or from a machine with
 * direct egress.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const APEX = 'https://levonis-iq.com/';
const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function parseArgs(argv) {
  const out = { urls: [], store: process.env.PSI_STORE_HOST || 'ali3d.levonis-iq.com', strategy: 'mobile', json: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.urls.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--store') out.store = next();
    else if (a === '--strategy') out.strategy = next();
    else if (a === '--json') out.json = next();
    else if (a === '--help' || a === '-h') { console.log('see the header of scripts/psi.mjs'); process.exit(0); }
    else { console.error(`psi: unknown flag ${a}`); process.exit(2); }
  }
  if (!['mobile', 'desktop'].includes(out.strategy)) { console.error('psi: --strategy is mobile or desktop'); process.exit(2); }
  if (!out.urls.length) {
    const host = out.store.includes('.') ? out.store : `${out.store}.levonis-iq.com`;
    out.urls = [APEX, `https://${host}/`];
  }
  return out;
}

const manualUrl = (url, strategy) => `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=${strategy}`;

const ms = (audit) => (audit && typeof audit.numericValue === 'number' ? `${Math.round(audit.numericValue)} ms` : '—');
const num = (audit, digits = 3) => (audit && typeof audit.numericValue === 'number' ? audit.numericValue.toFixed(digits) : '—');
const field = (metrics, key, format) => {
  const m = metrics?.[key];
  return m && typeof m.percentile === 'number' ? `${format(m.percentile)} (${m.category ?? '?'})` : '—';
};

async function runOne(url, strategy, key) {
  const q = new URLSearchParams({ url, strategy, category: 'performance', key });
  const res = await fetch(`${API}?${q}`, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.message || `${res.status} ${res.statusText}`;
    return { url, error: reason };
  }
  const lh = body.lighthouseResult ?? {};
  const a = lh.audits ?? {};
  const cats = lh.categories ?? {};
  const fieldMetrics = body.loadingExperience?.metrics ?? body.originLoadingExperience?.metrics;
  const fieldScope = body.loadingExperience?.metrics ? 'page' : body.originLoadingExperience?.metrics ? 'origin' : null;
  return {
    url,
    score: typeof cats.performance?.score === 'number' ? Math.round(cats.performance.score * 100) : null,
    fcp: ms(a['first-contentful-paint']),
    lcp: ms(a['largest-contentful-paint']),
    cls: num(a['cumulative-layout-shift']),
    tbt: ms(a['total-blocking-time']),
    si: ms(a['speed-index']),
    ttfb: ms(a['server-response-time']),
    field: {
      scope: fieldScope,
      lcp: field(fieldMetrics, 'LARGEST_CONTENTFUL_PAINT_MS', (v) => `${v} ms`),
      inp: field(fieldMetrics, 'INTERACTION_TO_NEXT_PAINT', (v) => `${v} ms`),
      cls: field(fieldMetrics, 'CUMULATIVE_LAYOUT_SHIFT_SCORE', (v) => (v / 100).toFixed(2)),
    },
    fetchTime: lh.fetchTime ?? null,
    lighthouse: lh.lighthouseVersion ?? null,
    raw: body,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const key = process.env.PSI_API_KEY;
  if (!key) {
    console.log('PSI_API_KEY is not set — open these by hand (same lab, same numbers):\n');
    for (const url of opts.urls) console.log(`  ${url}\n    ${manualUrl(url, opts.strategy)}`);
    console.log('\nRecord the performance score, LCP, CLS, TBT and the field p75 (if shown) in docs/PERFORMANCE_LOG.md.');
    return;
  }
  const results = [];
  for (const url of opts.urls) {
    process.stderr.write(`psi: ${opts.strategy} ${url} … `);
    const r = await runOne(url, opts.strategy, key);
    process.stderr.write(r.error ? `failed: ${r.error}\n` : `score ${r.score}\n`);
    results.push(r);
  }
  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n### PageSpeed Insights (${opts.strategy}) — ${date}\n`);
  console.log('| page | score | LCP | FCP | CLS | TBT | Speed Index | TTFB | field p75 LCP / INP / CLS |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) { console.log(`| ${r.url} | error | ${r.error.replace(/\|/g, '/')} | | | | | | |`); continue; }
    const f = r.field.scope ? `${r.field.lcp} / ${r.field.inp} / ${r.field.cls} (${r.field.scope})` : 'no field data';
    console.log(`| ${r.url} | **${r.score ?? '—'}** | ${r.lcp} | ${r.fcp} | ${r.cls} | ${r.tbt} | ${r.si} | ${r.ttfb} | ${f} |`);
  }
  if (opts.json) {
    const path = resolve(opts.json);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ date, strategy: opts.strategy, results: results.map((r) => r.raw ?? r) }, null, 1));
    console.log(`\nJSON: ${path}`);
  }
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((e) => { console.error('psi:', e); process.exit(1); });
