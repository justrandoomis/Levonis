#!/usr/bin/env node
/**
 * THE SHELL'S CHROME MUST NOT SIT ON THE ENGINE'S.
 *
 * Two defects prompted this probe, and it exists so neither can come back
 * unnoticed:
 *
 *  1. `.shell-actions` shipped at page-y 75..109, directly over the engine's
 *     own top bar at 72..97. Measured at 1366x1024, «توجيه تلقائي» occupied
 *     x 137..255 and covered the right half of [Save as 3mf] (x 91..200) and
 *     the whole of [STL] (x 208..252). A user pressing Save pressed auto-orient
 *     instead — which is exactly what the owner reported.
 *  2. The shell was an ordinary in-flow element, so any root scroll offset
 *     carried `.studio-header` above y=0 where `body{overflow:hidden}` made it
 *     unrecoverable.
 *
 * So this measures, in a real browser against a real build:
 *   - no LEVO control overlaps any engine control, at every iPad viewport;
 *   - the header sits at top 0 to begin with;
 *   - and it STILL sits at top 0 after the root is forcibly scrolled, which is
 *     the failure the owner hit.
 *
 * NOT part of `npm test`: it needs a running Studio and a Chromium binary.
 *
 *   npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-shell-layout.mjs
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-shell-layout.latest.json");
const target = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8799/";

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  if (existsSync(join(root, "chromium"))) return join(root, "chromium");
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium")) continue;
    for (const c of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome"]) {
      const full = join(root, entry, c);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const require = createRequire(import.meta.url);
let chromium;
for (const spec of ["playwright-core", "playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
  try { ({ chromium } = require(spec)); if (chromium) break; } catch { /* next */ }
}
if (!chromium) { console.error("shell-layout: no playwright available"); process.exit(1); }

const VIEWPORTS = [
  { name: "ipad-pro-landscape", width: 1366, height: 1024 },
  { name: "ipad-pro-portrait", width: 1024, height: 1366 },
  { name: "ipad-air-landscape", width: 1180, height: 820 },
  { name: "ipad-mini-landscape", width: 1133, height: 744 },
  { name: "desktop", width: 1680, height: 1050 },
];

/** Rects overlap only when they share area on BOTH axes. */
const overlaps = (a, b) =>
  a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.bottom && b.top < a.bottom;

const results = [];
let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(target, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500);

  const measure = () =>
    page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, w: r.width, h: r.height };
      };
      const label = (el) => (el.textContent || el.getAttribute("title") || "").trim().slice(0, 40);
      const levo = [];
      for (const el of document.querySelectorAll(".shell-actions button, .studio-header button, .studio-header label, .studio-header a")) {
        const r = rect(el);
        if (r.w > 0 && r.h > 0) levo.push({ ...r, text: label(el), where: el.closest(".shell-actions") ? "shell-actions" : "header" });
      }
      const engine = [];
      const host = document.querySelector("[data-levo-engine], .editor-area *");
      const roots = [];
      const walk = (node) => {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        for (const c of node.children ?? []) walk(c);
      };
      walk(document.body);
      for (const root of roots) {
        for (const el of root.querySelectorAll("button, .tb-btn, .tb-icon")) {
          const r = rect(el);
          if (r.w > 0 && r.h > 0) engine.push({ ...r, text: label(el) });
        }
      }
      const header = document.querySelector(".studio-header");
      const app = document.querySelector(".studio-app");
      return {
        levo,
        engine,
        header: header ? rect(header) : null,
        app: app ? rect(app) : null,
        appPosition: app ? getComputedStyle(app).position : null,
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        docClientHeight: document.documentElement.clientHeight,
        docScrollHeight: document.documentElement.scrollHeight,
        hostSeen: !!host,
      };
    });

  const before = await measure();
  console.log(`\n${vp.name} ${vp.width}x${vp.height}`);

  if (before.appPosition === "fixed") ok(`.studio-app is position: fixed`);
  else fail(`.studio-app is position: ${before.appPosition} — a root scroll can carry the header away`);

  if (before.header && Math.abs(before.header.top) < 1) ok(`.studio-header at top ${before.header.top.toFixed(1)}`);
  else fail(`.studio-header at top ${before.header?.top}`);

  // The collision that shipped this morning.
  const collisions = [];
  for (const a of before.levo) {
    for (const b of before.engine) {
      if (overlaps(a, b)) collisions.push({ levo: a.text, levoWhere: a.where, engine: b.text, a, b });
    }
  }
  if (collisions.length === 0) ok(`no LEVO control overlaps an engine control (${before.levo.length} vs ${before.engine.length} measured)`);
  else {
    fail(`${collisions.length} LEVO/engine collisions`);
    for (const c of collisions.slice(0, 6)) {
      console.log(`       «${c.levo}» (${c.levoWhere}) y ${c.a.top.toFixed(0)}..${c.a.bottom.toFixed(0)} x ${c.a.left.toFixed(0)}..${(c.a.left + c.a.w).toFixed(0)}`);
      console.log(`         over «${c.engine}» y ${c.b.top.toFixed(0)}..${c.b.bottom.toFixed(0)} x ${c.b.left.toFixed(0)}..${(c.b.left + c.b.w).toFixed(0)}`);
    }
  }

  // THE OWNER'S FAILURE: force the root down and check the header survives.
  await page.evaluate(() => {
    document.documentElement.style.height = `${window.innerHeight + 160}px`;
    window.scrollTo(0, 160);
  });
  await page.waitForTimeout(400);
  const after = await measure();
  if (after.header && after.header.top >= -1) {
    ok(`header survives a forced 160px root scroll (top ${after.header.top.toFixed(1)}, scrollY ${after.scrollY})`);
  } else {
    fail(`header at top ${after.header?.top} after a forced root scroll — the owner's bug is back`);
  }

  results.push({ viewport: vp, before, after, collisions: collisions.length });
  await page.screenshot({ path: join(STUDIO_ROOT, "tests", `shell-layout-${vp.name}.png`) });
  await ctx.close();
}

await browser.close();
writeFileSync(REPORT_PATH, JSON.stringify({ target, results }, null, 2));
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — report: ${REPORT_PATH}`);
process.exit(failures === 0 ? 0 : 1);
