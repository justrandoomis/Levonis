#!/usr/bin/env node
/**
 * A KEY THAT CHANGES NOTHING LEAVES A SYNCED ACCOUNT PROJECT SYNCED, IN A
 * REAL BROWSER (C6 fix lane, round 3: R3-REG-01 and R3-REG-02).
 *
 * Round 2 made every keyup on the window a candidate scene edit, so a key
 * that moves the model makes the slice result stale (c6fix-r2-ha-01). The
 * autosave marked the session dirty on each of them, and three things broke
 * for a signed-in person using the keyboard:
 *
 *   01  one Tab on desktop flipped the open project's badge from «Synced» to
 *       «Unsaved changes» for the length of the debounce;
 *   02  History > «Make this the current version» pressed with Enter did not
 *       reload the editor: it kept the newer version, said «Synced», and the
 *       next save met a 409;
 *   03  on a phone, Tab to the back chevron and Enter asked «مغادرة LEVO
 *       Studio؟» with nothing unsaved (the Tabs walk through the engine
 *       canvas and its plate tabs on the way).
 *
 * This drives the built app and checks all three, with the mouse paths that
 * always worked as the control. The main site is stubbed, so no request
 * leaves the machine.
 *
 * NOT part of `npm test`: it needs a built Studio, a local server, Chromium.
 *
 *   cd studio && npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-account-keys.mjs [http://127.0.0.1:8799/]
 *
 * Sign-in is the main site's handoff, which a local run does not have, so
 * the script seeds Studio sessions straight into the LOCAL D1 with `wrangler
 * d1 execute --local`, as browser-account-switch.mjs does. A server started
 * with `--persist-to <dir>` needs STUDIO_PERSIST_TO=<dir> here too.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-account-keys.latest.json");
const CUBE = join(STUDIO_ROOT, "tests", "fixtures", "cube-10mm.stl");
const TETRA = join(STUDIO_ROOT, "tests", "fixtures", "tetra-8mm.stl");
const target = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8799/";
const origin = new URL(target).origin;
const host = new URL(target).hostname;
// Pictures, only when a directory is named (never into the repository).
const SHOTS = process.env.ACCOUNT_KEYS_SHOTS ?? null;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }).catch(() => {}) : Promise.resolve());

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
if (!chromium) { console.error("account-keys: no playwright available"); process.exit(1); }

const checks = [];
let failures = 0;
const fail = (m, detail) => { failures++; checks.push({ ok: false, m, detail }); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ""}`); };
const ok = (m, detail) => { checks.push({ ok: true, m, detail }); console.log(`  ok   ${m}${detail ? ` — ${detail}` : ""}`); };
const assert = (cond, m, detail) => (cond ? ok(m, detail) : fail(m, detail));

// ---------------------------------------------------------------------------
// Sessions, seeded into the local D1
// ---------------------------------------------------------------------------

const run = randomBytes(4).toString("hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TOKENS = { desk: randomBytes(32).toString("hex"), phone: randomBytes(32).toString("hex") };
const expires = new Date(Date.now() + 3_600_000).toISOString();
const seedSql = [
  `CREATE TABLE IF NOT EXISTS studio_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT 'ar', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '')`,
  `INSERT INTO studio_sessions (id, user_id, display_name, locale, expires_at) VALUES ('${sha256(TOKENS.desk)}', 'keys-desk-${run}', 'Desk', 'en', '${expires}')`,
  `INSERT INTO studio_sessions (id, user_id, display_name, locale, expires_at) VALUES ('${sha256(TOKENS.phone)}', 'keys-phone-${run}', 'Phone', 'ar', '${expires}')`,
].join("; ");
const persist = process.env.STUDIO_PERSIST_TO ? ["--persist-to", process.env.STUDIO_PERSIST_TO] : [];
execFileSync("npx", ["wrangler", "d1", "execute", "levonis-studio-db", "--local", ...persist, "--command", seedSql], {
  cwd: STUDIO_ROOT,
  stdio: ["ignore", "ignore", "inherit"],
});
console.log(`seeded two sessions (run ${run})`);

const browser = await chromium.launch({ executablePath: findChromium() ?? undefined, args: ["--no-sandbox"] });
const pageErrors = [];

async function openSignedIn({ token, viewport, lang, phone }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, colorScheme: "dark" });
  // The back chevron goes to the main site: answer it here.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>stub" }));
  await ctx.addInitScript(([locale]) => {
    try {
      window.localStorage.setItem("levo-studio-printer", "bbl-a1-04");
      window.localStorage.setItem("levo-studio-locale", locale);
      window.localStorage.setItem("levo-studio-theme", "dark");
    } catch { /* ignore */ }
  }, [lang]);
  await ctx.addCookies([{ name: "levo_studio_session", value: token, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 160)));
  const traffic = [];
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/api/projects")) traffic.push({ t: Date.now(), m: res.request().method(), u: url.replace(origin, "").replace(/[0-9a-f]{20,}/g, ":id"), s: res.status() });
  });
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message().slice(0, 140)); await dialog.dismiss(); });
  await page.goto(target, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  return { ctx, page, traffic, dialogs };
}

const objectCount = (page) => page.evaluate(() => window.__vpApi?.()?.sceneSnapshot?.()?.length ?? null);

async function importModel(page, file, atLeast) {
  await page.setInputFiles("input.native-file-input >> nth=0", file, { timeout: 60_000 });
  await page.waitForFunction((n) => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length >= n, atLeast, { timeout: 120_000 });
  await page.waitForTimeout(2500);
}

async function serverHead(ctx, prefix) {
  const list = await (await ctx.request.fetch(`${origin}/api/projects`, { headers: { Origin: origin } })).json();
  const project = (list.projects ?? []).find((entry) => String(entry.name).startsWith(prefix)) ?? (prefix ? null : (list.projects ?? [])[0]);
  return project ? { id: project.id, head: project.head_revision } : null;
}

async function waitHead(page, ctx, prefix, wanted, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const head = await serverHead(ctx, prefix);
    if (head && head.head >= wanted) return head;
    await page.waitForTimeout(500);
  }
  return serverHead(ctx, prefix);
}

const badge = (page) => page.evaluate(() => {
  const element = document.querySelector(".levo-projects-panel .lpp-status");
  return element ? { cls: [...element.classList].find((name) => name.startsWith("lpp-status-")) ?? null, text: element.textContent.trim() } : null;
});

async function openPanel(page) {
  if (!(await page.locator(".levo-projects-panel").count())) await page.locator(".projects-action").click();
  await page.locator(".levo-projects-panel").waitFor({ timeout: 20_000 });
  await page.locator('.levo-projects-panel .lpp-tabs [role="tab"]').nth(0).click();
}

async function closePanel(page) {
  if (!(await page.locator(".levo-projects-panel").count())) return;
  await page.keyboard.press("Escape");
  await page.locator(".sheet-backdrop").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
}

// =========================================================================
// 01 + 02 — DESKTOP: ONE TAB, AND A RESTORE PRESSED WITH ENTER
// =========================================================================
console.log("\n01/02: desktop, signed in (en)");
{
  const name = `Keys-${run}`;
  const { ctx, page, traffic } = await openSignedIn({ token: TOKENS.desk, viewport: { width: 1440, height: 1000 }, lang: "en", phone: false });
  await importModel(page, CUBE, 1);
  await openPanel(page);
  await page.locator(".lpp-create input").fill(name);
  await page.locator(".lpp-create button").click();
  const v1 = await waitHead(page, ctx, name, 1);
  await page.waitForFunction(() => document.querySelector(".levo-projects-panel .lpp-status-synced"), null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  assert(v1?.head === 1 && (await badge(page))?.cls === "lpp-status-synced", "version 1 is the account project, synced", JSON.stringify(v1));

  // 01: one Tab from the search field (put there without a key).
  await page.locator(".lpp-toolbar input[type=search]").focus();
  await page.waitForTimeout(300);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  const soon = await badge(page);
  await page.waitForTimeout(3500);
  const later = await badge(page);
  assert(soon?.cls === "lpp-status-synced" && later?.cls === "lpp-status-synced", "one Tab leaves the open project «Synced»", `${soon?.text} / ${later?.text}`);
  await shot(page, "account-keys-tab-badge.png");
  await closePanel(page);

  // Version 2: a second model, saved by the editor's own autosave.
  await page.waitForTimeout(2000);
  await importModel(page, TETRA, 2);
  const v2 = await waitHead(page, ctx, name, 2);
  await page.waitForTimeout(4000);
  assert(v2?.head === 2 && await objectCount(page) === 2, "version 2 (two models) is saved by the autosave", JSON.stringify(v2));

  // 02: History > «Make this the current version» on version 1, all with Enter.
  await openPanel(page);
  const card = page.locator(".levo-projects-panel .lpp-card", { hasText: name }).first();
  await card.waitFor({ timeout: 10_000 });
  await card.getByRole("button", { name: "History" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".lpp-version").length >= 2, null, { timeout: 15_000 });
  await page.waitForTimeout(4000);
  const versions = page.locator(".lpp-version");
  const mark = Date.now();
  await versions.nth(1).getByRole("button", { name: "Make this the current version" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await versions.nth(1).locator(".lpp-confirm button.lpp-primary").focus();
  await page.keyboard.press("Enter");
  await page.getByText(/is now the current version/).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(8000);
  const after = traffic.filter((entry) => entry.t >= mark && entry.m === "GET").map((entry) => entry.u);
  const reloaded = after.some((u) => /\/revisions\/:id$/.test(u)) && after.some((u) => /\/files\/:id/.test(u));
  assert(reloaded, "restored with the keyboard, the editor fetches the version and its file", after.join(" · "));
  assert(await objectCount(page) === 1, "…and holds version 1 again: one model", String(await objectCount(page)));
  await shot(page, "account-keys-restored.png");
  await closePanel(page);

  // The next real edit saves on top of the restored head, never a 409.
  await page.waitForTimeout(1000);
  const before = traffic.length;
  await importModel(page, TETRA, 2);
  await page.waitForTimeout(12_000);
  const writes = traffic.slice(before).filter((entry) => entry.m === "POST" && /\/revisions$/.test(entry.u));
  assert(writes.length > 0 && writes.every((entry) => entry.s === 201), "the next edit saves with a 201, never a 409", writes.map((entry) => `${entry.u} ${entry.s}`).join(" · "));
  await ctx.close();
}

// =========================================================================
// 03 — PHONE: THE BACK CHEVRON BY KEYBOARD, ON A SETTLED SYNCED PROJECT
// =========================================================================
console.log("\n03: phone, signed in (ar, dark)");
{
  const { ctx, page, dialogs } = await openSignedIn({ token: TOKENS.phone, viewport: { width: 390, height: 844 }, lang: "ar", phone: true });
  await importModel(page, CUBE, 1);
  await page.locator('[data-levo-action="save-now"]').click();
  const head = await waitHead(page, ctx, "", 1);
  // Settled: the account has the work and every debounce has run out.
  await page.waitForTimeout(12_000);
  assert(head?.head >= 1, "«حفظ» saved the project to the account", JSON.stringify(head));
  const x = await page.evaluate(() => window.__vpApi().sceneSnapshot()[0]?.pos.x ?? null);
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  let tabs = 0;
  for (; tabs < 60; tabs += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.classList?.contains("m-topbar__back"))) break;
  }
  const reached = await page.evaluate(() => document.activeElement?.classList?.contains("m-topbar__back") ?? false);
  assert(reached, "Tab reaches «العودة إلى LEVONIS», through the engine canvas and its plate tabs", `${tabs + 1} Tab(s)`);
  assert(x === await page.evaluate(() => window.__vpApi().sceneSnapshot()[0]?.pos.x ?? null), "…and the Tabs moved nothing");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  assert(dialogs.length === 0, "Enter on the chevron asks nothing: nothing is unsaved", dialogs.join(" | "));
  assert(!page.url().startsWith(origin), "…and leaves for the main site", page.url());
  await ctx.close();
}

assert(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));
await browser.close();

writeFileSync(REPORT_PATH, JSON.stringify({ target, failures, checks }, null, 2) + "\n");
console.log(`\naccount-keys: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
