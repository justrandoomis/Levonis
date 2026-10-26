#!/usr/bin/env node
/**
 * SIMPLE MODE AND THE P1-10 HARDENING, IN A REAL BROWSER.
 *
 * The node tests pin the CSS text, the reconcile rule and the API. These are
 * only true if Chromium agrees, so this drives the built Studio:
 *
 *   S6  a first visit opens in Simple at desktop AND phone width: the engine
 *       side panel is not displayed at either, the dead engine controls are
 *       gone, and there is still a way to slice (header on desktop, the gold
 *       button of the phone column) — the mode switch is on the phone page,
 *       and the overflow's Settings opens the Setup sheet;
 *   10  warnings in Simple (regression): an over-bed model shows the engine's
 *       bed warning, and slicing it puts the over-bed refusal in the shell's
 *       own message row, with the side panel hidden the whole time;
 *       Advanced brings the panel and the (disabled) controls back;
 *   S7  the choice is mirrored on the device (survives a reload as a guest)
 *       and stored on the account: device 2 of the same account opens in the
 *       mode device 1 chose, another account still opens in Simple;
 *   Q8  through the real worker: a cookie jar with a forged levonis_session
 *       next to the Studio's own session still signs the Studio in, the
 *       main-site cookie alone signs nobody in; a cross-site write is 403.
 *
 * NOT part of `npm test`: it needs a built Studio, a local server, Chromium.
 *
 *   cd studio && npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-simple-mode.mjs [http://127.0.0.1:8799/]
 *
 * Sessions are seeded straight into the LOCAL D1 with `wrangler d1 execute
 * --local`, as tests/browser-account-switch.mjs does.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-simple-mode.latest.json");
// The engine's bed warning is checked with a model bigger than the bed. The
// slice is checked with a small tower pushed past the bed edge instead:
// over-bed for certain and cheap to slice (slicing the 300 mm cube exhausts a
// headless tab's WASM heap, which tests the browser, not Simple mode).
const OVERSIZED = join(STUDIO_ROOT, "tests", "fixtures", "cube-300mm.stl");
const TOWER = join(STUDIO_ROOT, "tests", "fixtures", "tower-8x8x90.stl");
const target = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8799/";
const origin = new URL(target).origin;
const host = new URL(target).hostname;

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
if (!chromium) { console.error("simple-mode: no playwright available"); process.exit(1); }

const checks = [];
let failures = 0;
const fail = (m, detail) => { failures++; checks.push({ ok: false, m, detail }); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ""}`); };
const ok = (m, detail) => { checks.push({ ok: true, m, detail }); console.log(`  ok   ${m}${detail ? ` — ${detail}` : ""}`); };
const assert = (cond, m, detail) => (cond ? ok(m, detail) : fail(m, detail));

// ---------------------------------------------------------------------------
// Sessions, seeded into the local D1
// ---------------------------------------------------------------------------

const run = randomBytes(4).toString("hex");
const USER_A = `simple-a-${run}`;
const USER_B = `simple-b-${run}`;
const token = () => randomBytes(32).toString("hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TOKENS = { a1: token(), a2: token(), b: token() };
const expires = new Date(Date.now() + 3_600_000).toISOString();
const seedSql = [
  `CREATE TABLE IF NOT EXISTS studio_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT 'ar', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '')`,
  ...[["a1", USER_A, "Alpha"], ["a2", USER_A, "Alpha"], ["b", USER_B, "Bravo"]].map(
    ([k, user, name]) =>
      `INSERT INTO studio_sessions (id, user_id, display_name, locale, expires_at) VALUES ('${sha256(TOKENS[k])}', '${user}', '${name}', 'en', '${expires}')`
  ),
].join("; ");
execFileSync("npx", ["wrangler", "d1", "execute", "levonis-studio-db", "--local", "--command", seedSql], {
  cwd: STUDIO_ROOT,
  stdio: ["ignore", "ignore", "inherit"],
});
console.log(`seeded sessions for ${USER_A} (x2) and ${USER_B}`);

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const PRINTER_KEY = "levo-studio-printer";
const LOCALE_KEY = "levo-studio-locale";
const browser = await chromium.launch({ executablePath: findChromium() ?? undefined, args: ["--no-sandbox"] });
const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };
const HIDDEN_TOOLS = ["tool-arrange", "tool-orient", "tool-cut", "tool-boolean", "tool-negative", "tool-seam", "tool-mmu", "tool-text", "tool-measure", "tool-varlayer"];

async function newDevice(viewport, sessionToken = null) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 900, isMobile: viewport.width < 900 });
  await context.addInitScript(([pk, pv, lk, lv]) => {
    try {
      if (!window.localStorage.getItem(pk)) window.localStorage.setItem(pk, pv);
      if (!window.localStorage.getItem(lk)) window.localStorage.setItem(lk, lv);
    } catch { /* ignore */ }
  }, [PRINTER_KEY, "bbl-x2d-04", LOCALE_KEY, "en"]);
  if (sessionToken) {
    await context.addCookies([{ name: "levo_studio_session", value: sessionToken, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  }
  return context;
}

async function open(context) {
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 90_000 });
  // The engine host carries the mode attribute once the adapter has found it.
  await page.waitForFunction(() => {
    const mount = document.querySelector(".viewport-mount");
    if (!mount) return false;
    for (const el of mount.querySelectorAll("*")) if (el.shadowRoot?.querySelector(".app-shell")) return el.hasAttribute("data-levo-mode");
    return false;
  }, null, { timeout: 60_000 });
  return page;
}

/** Engine-side state, read through the shadow root. */
function engineState(page) {
  return page.evaluate((hiddenTools) => {
    const mount = document.querySelector(".viewport-mount");
    let hostEl = null;
    for (const el of mount.querySelectorAll("*")) if (el.shadowRoot?.querySelector(".app-shell")) { hostEl = el; break; }
    const root = hostEl.shadowRoot;
    const display = (sel) => {
      const el = root.querySelector(sel);
      return el ? getComputedStyle(el).display : null;
    };
    const tools = {};
    for (const id of hiddenTools) tools[id] = display(`[data-testid="${id}"]`);
    const bedWarn = root.querySelector('[data-testid="bed-warn"]');
    return {
      mode: hostEl.getAttribute("data-levo-mode"),
      sidebar: display(".sidebar"),
      tools,
      deleteTool: display('[data-testid="tool-delete"]'),
      booleanDisabled: root.querySelector('[data-testid="tool-boolean"]')?.disabled ?? null,
      bedWarn: bedWarn ? { display: getComputedStyle(bedWarn).display, text: bedWarn.textContent.trim().slice(0, 120) } : null,
    };
  }, HIDDEN_TOOLS);
}

const shellDisplay = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display : null;
  }, selector);

const report = { origin, run };

try {
  // -------------------------------------------------------------------------
  // S6 + 10: a guest on a desktop
  // -------------------------------------------------------------------------
  console.log("desktop guest (Simple by default)");
  const desk = await newDevice(DESKTOP);
  const page = await open(desk);
  let state = await engineState(page);
  report.desktopSimple = state;
  assert(state.mode === "simple", "a first visit opens in Simple", state.mode);
  assert(state.sidebar === "none", "the engine side panel is not displayed at desktop width", state.sidebar);
  assert(Object.values(state.tools).every((d) => d === "none"), "every dead engine control is hidden", JSON.stringify(state.tools));
  assert(state.deleteTool !== "none", "a working engine control stays", state.deleteTool);
  assert(await shellDisplay(page, ".header-slice-action") !== null && (await shellDisplay(page, ".header-slice-action")) !== "none", "the header carries the slice action in Simple");
  assert((await page.locator(".panel-button").count()) === 0, "the side-panel toggle is gone in Simple");

  // A model bigger than the bed: the engine's bed warning sits outside the
  // hidden panel, so Simple shows it.
  const big = await open(desk);
  await big.setInputFiles("input.native-file-input >> nth=0", OVERSIZED, { timeout: 60_000 });
  await big.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 90_000 });
  await big.waitForTimeout(800);
  state = await engineState(big);
  report.desktopBedWarning = state;
  assert(state.bedWarn && state.bedWarn.display !== "none", "the engine's bed warning shows in Simple", state.bedWarn?.text);
  assert(state.sidebar === "none", "the side panel stays hidden with a model loaded", state.sidebar);
  await big.close();

  // The slice: the X2D bed is 256 mm, so a centre 140 mm from the plate
  // centre puts the 8 mm tower across the edge.
  await page.setInputFiles("input.native-file-input >> nth=0", TOWER, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 90_000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const api = window.__vpApi();
    api.placeObjectOnPlate(api.sceneSnapshot()[0].id, 0, 140, 0);
  });
  await page.waitForTimeout(500);

  // Slice from the header: the refusal lands in the shell's own message row.
  // The import's own notice (the oversized model could not be placed) is in
  // that row first; dismiss it so the next message is the slice's answer.
  if (await page.locator(".editor-message").count()) {
    report.importNotice = (await page.locator(".editor-message").textContent()).trim();
    await page.locator(".editor-message button").last().click();
  }
  await page.locator(".header-slice-action").click();
  const message = await page.waitForSelector(".editor-message.error", { timeout: 180_000 }).catch(() => null);
  const messageText = message ? (await message.textContent()).trim() : "";
  report.desktopSliceMessage = messageText;
  assert(Boolean(messageText), "slicing an over-bed model in Simple shows the refusal in the shell", messageText.slice(0, 160));
  assert(/build volume|bed|exceed/i.test(messageText), "…and it is the over-bed warning", messageText.slice(0, 160));
  state = await engineState(page);
  assert(state.sidebar === "none", "the side panel was never needed to see it", state.sidebar);

  // Advanced from the Setup sheet: panel and (disabled) controls come back.
  await page.locator(".profile-button").click();
  await page.locator('[data-levo-mode-option="advanced"]').click();
  await page.waitForFunction(() => {
    const mount = document.querySelector(".viewport-mount");
    for (const el of mount.querySelectorAll("*")) if (el.shadowRoot?.querySelector(".app-shell")) return el.getAttribute("data-levo-mode") === "advanced";
    return false;
  }, null, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  state = await engineState(page);
  report.desktopAdvanced = state;
  assert(state.sidebar !== "none", "Advanced shows the engine side panel at desktop width", state.sidebar);
  assert(state.tools["tool-boolean"] !== "none" && state.booleanDisabled === true, "Advanced shows the dead controls, disabled, as before");
  assert((await page.locator(".panel-button").count()) === 1, "the side-panel toggle is back in Advanced");
  // The guest's choice is mirrored on this device.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => {
    const mount = document.querySelector(".viewport-mount");
    if (!mount) return false;
    for (const el of mount.querySelectorAll("*")) if (el.shadowRoot?.querySelector(".app-shell")) return el.getAttribute("data-levo-mode") === "advanced";
    return false;
  }, null, { timeout: 60_000 }).then(() => ok("a guest's choice survives a reload (local mirror)"), () => fail("a guest's choice survives a reload (local mirror)"));
  await desk.close();

  // -------------------------------------------------------------------------
  // S6: a guest on a phone
  // -------------------------------------------------------------------------
  console.log("phone guest");
  const phone = await newDevice(PHONE);
  const pp = await open(phone);
  state = await engineState(pp);
  report.phoneSimple = state;
  assert(state.mode === "simple" && state.sidebar === "none", "Simple on a phone: no side panel", `${state.mode} / ${state.sidebar}`);
  // CHANGED DELIBERATELY (plan item C6): the phone is the reference column.
  // The desktop header, with its slice action, is hidden there; the column
  // has its own gold slice button and the mode switch on the page itself.
  assert((await shellDisplay(pp, ".studio-header")) === "none", "the desktop header (and its slice action) is desktop-only");
  assert((await shellDisplay(pp, '[data-levo-action="phone-slice"]')) !== "none", "the phone keeps its own slice action");
  assert((await pp.locator('[data-levo-control="mode"] [data-levo-mode-choice="simple"][aria-checked="true"]').count()) === 1, "the mode switch is on the page, set to Simple");
  // Settings is still one sheet away, through the overflow.
  await pp.locator('[data-levo-action="more"]').click();
  await pp.locator('[data-levo-more="settings"]').click();
  const sheetOpen = await pp.waitForSelector(".studio-sheet .mode-control", { timeout: 10_000 }).then(() => true, () => false);
  assert(sheetOpen, "the overflow's Settings opens the Setup sheet (with the mode switch) in Simple");
  state = await engineState(pp);
  assert(state.sidebar === "none", "…and never a side panel that Simple hides", state.sidebar);
  await phone.close();

  // -------------------------------------------------------------------------
  // S7: the account's choice follows it to another device
  // -------------------------------------------------------------------------
  console.log("signed in: account A on two devices, then account B");
  const d1 = await newDevice(DESKTOP, TOKENS.a1);
  const p1 = await open(d1);
  state = await engineState(p1);
  assert(state.mode === "simple", "account A opens in Simple (never chose)", state.mode);
  await p1.locator(".profile-button").click();
  const put = p1.waitForResponse((r) => r.url().endsWith("/api/prefs") && r.request().method() === "PUT", { timeout: 15_000 });
  await p1.locator('[data-levo-mode-option="advanced"]').click();
  const putRes = await put.catch(() => null);
  assert(putRes?.status() === 200, "the choice is stored on the account (PUT /api/prefs 200, same-origin)", String(putRes?.status()));
  await d1.close();

  const d2 = await newDevice(DESKTOP, TOKENS.a2);
  const p2 = await open(d2);
  const followed = await p2.waitForFunction(() => {
    const mount = document.querySelector(".viewport-mount");
    for (const el of mount.querySelectorAll("*")) if (el.shadowRoot?.querySelector(".app-shell")) return el.getAttribute("data-levo-mode") === "advanced";
    return false;
  }, null, { timeout: 20_000 }).then(() => true, () => false);
  assert(followed, "device 2 of account A opens in Advanced, from the server");
  await d2.close();

  const d3 = await newDevice(DESKTOP, TOKENS.b);
  const p3 = await open(d3);
  await p3.waitForTimeout(2500);
  state = await engineState(p3);
  assert(state.mode === "simple", "account B still opens in Simple", state.mode);
  await d3.close();

  // -------------------------------------------------------------------------
  // Q8 + origin, through the real worker
  // -------------------------------------------------------------------------
  console.log("worker hardening");
  const raw = await browser.newContext();
  const me = async (cookie) => {
    const res = await raw.request.fetch(`${origin}/auth/me`, { headers: { Cookie: cookie } });
    return (await res.json()).user;
  };
  const forged = `levonis_session=${token()}`;
  const both = await me(`${forged}; levo_studio_session=${TOKENS.b}`);
  assert(both?.id === USER_B, "a forged levonis_session beside the Studio cookie: the Studio session still works", both?.id);
  assert((await me(forged)) === null, "the main-site cookie alone signs nobody in to Studio");
  const cross = await raw.request.fetch(`${origin}/api/prefs`, {
    method: "PUT",
    data: { mode: "advanced" },
    headers: { Cookie: `levo_studio_session=${TOKENS.b}`, Origin: "https://ali3d.levonis-iq.com" },
  });
  assert(cross.status() === 403, "a write from a store subdomain is refused (403)", String(cross.status()));
  const after = await raw.request.fetch(`${origin}/api/prefs`, { headers: { Cookie: `levo_studio_session=${TOKENS.b}` } });
  assert((await after.json()).prefs?.mode === "simple", "…and changed nothing");
  await raw.close();
} catch (error) {
  fail("the run finished", error?.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

report.checks = checks;
report.passed = checks.length - failures;
report.total = checks.length;
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nsimple-mode: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
