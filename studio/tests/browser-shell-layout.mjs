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
 *     the failure the owner hit;
 *   - EVERY header control lies inside the window (left >= 0, right <=
 *     innerWidth) at every viewport, in Arabic, Sorani and English, in Simple
 *     and in Advanced. The header clips its overflow and cannot scroll, so in
 *     RTL a too-wide action row runs off the LEFT edge and Files / New
 *     project become unreachable — which P1-10's Simple slice action did at
 *     1133px and 1024px before the header learned to narrow, and in Sorani
 *     at 1181-1300px (an 11" iPad Pro in landscape is 1194px).
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

/**
 * The header-fit pass also covers the band between the tablet widths and a
 * wide desktop, where each narrowing step in globals.css switches: Sorani
 * Simple once had Files off-screen at 1181-1240px and partly off at
 * 1280-1300px, and none of the widths above sat in that band.
 */
const HEADER_FIT_VIEWPORTS = [
  ...VIEWPORTS,
  { name: "ipad-pro-11-landscape", width: 1194, height: 834 },
  { name: "laptop-1240", width: 1240, height: 800 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "laptop-1300", width: 1300, height: 800 },
  { name: "laptop-1330", width: 1330, height: 800 },
  { name: "laptop-1360", width: 1360, height: 768 },
  { name: "laptop-1440", width: 1440, height: 900 },
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

// EVERY HEADER CONTROL INSIDE THE WINDOW, in each language and each mode.
const LOCALE_KEY = "levo-studio-locale";
const GUEST_MODE_KEY = "levo-studio-mode/guest";
const overflow = [];
for (const vp of HEADER_FIT_VIEWPORTS) {
  for (const locale of ["ar", "ckb", "en"]) {
    for (const mode of ["simple", "advanced"]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      await ctx.addInitScript(([lk, lv, mk, mv]) => {
        try {
          window.localStorage.setItem(lk, lv);
          window.localStorage.setItem(mk, mv);
        } catch { /* ignore */ }
      }, [LOCALE_KEY, locale, GUEST_MODE_KEY, mode]);
      const page = await ctx.newPage();
      await page.goto(target, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      const measured = await page.evaluate(() => {
        const controls = [];
        for (const el of document.querySelectorAll(".studio-header button, .studio-header a, .studio-header label")) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().slice(0, 40);
          controls.push({ name, left: r.left, right: r.right });
        }
        const sliceShown = Boolean(document.querySelector('[data-levo-action="simple-slice"]'));
        return { controls, innerWidth: window.innerWidth, lang: document.documentElement.lang, sliceShown };
      });
      const outside = measured.controls.filter((c) => c.left < -0.5 || c.right > measured.innerWidth + 0.5);
      const label = `${vp.name} ${vp.width}px ${locale} ${mode}`;
      if (mode === "simple" && vp.width >= 900 && !measured.sliceShown) fail(`${label}: the Simple slice action is not in the header`);
      if (outside.length === 0) ok(`${label}: ${measured.controls.length} header controls inside the window`);
      else {
        fail(`${label}: ${outside.length} header control(s) outside the window`);
        for (const c of outside) console.log(`       «${c.name}» x ${c.left.toFixed(1)}..${c.right.toFixed(1)} of ${measured.innerWidth}`);
      }
      overflow.push({ viewport: vp.name, width: vp.width, locale, mode, lang: measured.lang, outside, controls: measured.controls });
      await ctx.close();
    }
  }
}

await browser.close();
writeFileSync(REPORT_PATH, JSON.stringify({ target, results, overflow }, null, 2));
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — report: ${REPORT_PATH}`);
process.exit(failures === 0 ? 0 : 1);
