#!/usr/bin/env node
/**
 * THE PHONE SHELL'S KEYS, SHEETS AND MESSAGES, IN A REAL BROWSER (C6 fix
 * lane, round 2).
 *
 * The unit tests in phone-shell.test.mjs pin the source. These eight are only
 * true if the browser agrees, so this drives the built app on a phone:
 *
 *   01  an arrow pressed on a shell control that the engine turns into a
 *       nudge («المزيد», the G-code tile) makes the result stale at once:
 *       «نتيجة قديمة», the G-code tile disabled, nothing downloaded; and a key
 *       still held down (no keyup yet) is caught when the tile is pressed;
 *   02  the arrows, Home and End walk the transform toolbar, with one tab
 *       stop, and move nothing: a fresh result stays fresh;
 *   03  the Settings «الدعامات» switch has a name and a 44 px box;
 *   04  the printer grid, the Settings mode and the connection tabs are
 *       walked with the arrows, with one tab stop each;
 *   05  the Settings tiers are radios, the chosen one checked and marked;
 *   06  the arrange and orientation notices are counted («مجسم واحد»), and a
 *       preset that takes an edit back says how many, never «layer_height»;
 *   07  the Settings tiers are named in Arabic and Sorani;
 *   08  the About sheet's legal summary and source link are 44 px tall.
 *
 * Round 3 (c6fix-r3):
 *
 *   09  the «تراجع عن القص» offer goes when the objects change by another
 *       path (delete all, a duplicate, a ZIP import) and still undoes the
 *       cut when nothing else changed; the cut and the ZIP notices count
 *       in the reader's language («قطعتين», «مجسمين»);
 *   10  the Projects sheet tabs: ink on the sand at 4.5:1 or more, 44 px
 *       tall, a named tablist, one tab stop, the arrows walk, and each tab
 *       controls the tabpanel it labels;
 *   11  the chosen connection way carries the check mark and the sand
 *       selection: its edge or fill 3:1 against the track, its label 4.5:1;
 *   12  the arrows on the viewport card's own toolbar walk its buttons with
 *       one tab stop, and move no model: a fresh result stays fresh.
 *
 * NOT part of `npm test`: it needs a built Studio, a server, and Chromium.
 *
 *   cd studio && npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-shell-keys.mjs [http://127.0.0.1:8799/]
 *
 * SHELL_KEYS_SHOTS=<dir> also saves pictures there: the outdated banner
 * after the key, the Settings sheet, the carry-over notice, and (round 3)
 * the message row after each undo step, the Projects tabs and the
 * connection tabs.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-shell-keys.latest.json");
const TOWER = join(STUDIO_ROOT, "tests", "fixtures", "tower-8x8x90.stl");
const CUBE = join(STUDIO_ROOT, "tests", "fixtures", "cube-10mm.stl");
const target = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8799/";
// Pictures of three moments, only when a directory is named (never into the repository).
const SHOTS = process.env.SHELL_KEYS_SHOTS ?? null;
const shot = (locator, name) => (SHOTS ? locator.screenshot({ path: join(SHOTS, name) }).catch(() => {}) : Promise.resolve());

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
if (!chromium) { console.error("shell-keys: no playwright available"); process.exit(1); }

const PHONE = { width: 390, height: 844 };

const checks = [];
let failures = 0;
const fail = (m, detail) => { failures++; checks.push({ ok: false, m, detail }); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ""}`); };
const ok = (m, detail) => { checks.push({ ok: true, m, detail }); console.log(`  ok   ${m}${detail ? ` — ${detail}` : ""}`); };
const assert = (cond, m, detail) => (cond ? ok(m, detail) : fail(m, detail));

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const pageErrors = [];

/** A phone with the language, the appearance and the printer already chosen. */
async function openStudio(lang, theme) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, acceptDownloads: true });
  await ctx.addInitScript(([locale, appearance]) => {
    try {
      window.localStorage.setItem("levo-studio-locale", locale);
      window.localStorage.setItem("levo-studio-theme", appearance);
      window.localStorage.setItem("levo-studio-printer", "bbl-a1-04");
    } catch { /* ignore */ }
  }, [lang, theme]);
  const page = await ctx.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${lang}/${theme}: ${String(error).slice(0, 160)}`));
  await page.goto(target, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 90_000 });
  await page.waitForTimeout(1000);
  return { ctx, page };
}

async function dismissMessages(page) {
  const close = page.locator(".studio-messages .editor-message button[aria-label]");
  for (let i = 0; i < 3 && await close.count(); i += 1) await close.last().click().catch(() => {});
}

async function load(page, file) {
  await page.setInputFiles("input.native-file-input >> nth=0", file, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  await dismissMessages(page);
}

const sliceState = (page) => page.evaluate(() => document.querySelector('[data-levo-action="phone-slice"]')?.getAttribute("data-state") ?? null);

async function slice(page) {
  await page.locator('[data-levo-action="phone-slice"]').click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-levo-action="phone-slice"]');
    return button?.getAttribute("data-state") === "sliced" || Boolean(document.querySelector(".editor-message.error"));
  }, null, { timeout: 240_000, polling: 500 }).catch(() => {});
  await page.waitForTimeout(600);
  await dismissMessages(page);
}

/** Back to Prepare after a slice (the engine opens its preview), with the model selected. */
async function prepareAndSelect(page) {
  await page.locator('[data-levo-action="more"]').click();
  await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
  await page.locator('[data-levo-more="toggle-preview"]').click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const api = window.__vpApi(); api.selectObject?.(api.sceneSnapshot()[0]?.id); });
  await page.waitForTimeout(300);
}

const look = (page) => page.evaluate(() => {
  const tile = document.querySelector('[data-levo-action="export-gcode"]');
  const active = document.activeElement;
  let x = null;
  try { x = Math.round(window.__vpApi().sceneSnapshot()[0].pos.x * 10) / 10; } catch { /* no engine */ }
  return {
    readiness: document.querySelector("[data-levo-readiness]")?.getAttribute("data-levo-readiness") ?? null,
    gcodeDisabled: tile ? tile.disabled : null,
    slice: document.querySelector('[data-levo-action="phone-slice"]')?.getAttribute("data-state") ?? null,
    x,
    focus: active?.getAttribute("data-levo-tool") ?? active?.getAttribute("data-levo-action") ?? active?.tagName ?? null,
    message: document.querySelector(".studio-messages")?.textContent.trim() ?? "",
  };
});

/** Presses the G-code tile; the download, or null when nothing came. */
async function pressGcodeTile(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 4000 }).catch(() => null),
    page.locator('[data-levo-action="export-gcode"]').click({ timeout: 2000 }).catch(() => null),
  ]);
  return download;
}

async function waitForReadiness(page, wanted, ms = 2000) {
  await page.waitForFunction((value) => document.querySelector("[data-levo-readiness]")?.getAttribute("data-levo-readiness") === value, wanted, { timeout: ms, polling: 50 }).catch(() => {});
}

async function openMore(page, item) {
  await page.locator('[data-levo-action="more"]').click();
  await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
  await page.locator(`[data-levo-more="${item}"]`).click();
  await page.waitForTimeout(800);
}

async function closeSheet(page) {
  if (await page.locator(".studio-sheet").count()) await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

const focusInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { text: (a?.textContent ?? "").trim(), role: a?.getAttribute("role"), checked: a?.getAttribute("aria-checked"), selected: a?.getAttribute("aria-selected"), tab: a?.tabIndex ?? null };
});

// =========================================================================
// 01 + 02 — A KEY THAT MOVES THE MODEL MAKES THE RESULT STALE; THE TOOLBAR'S KEYS MOVE NOTHING
// =========================================================================
console.log("\n01/02: keys on the shell and the slice result (ar, dark)");
{
  const { ctx, page } = await openStudio("ar", "dark");
  await load(page, TOWER);
  await slice(page);
  assert(await sliceState(page) === "sliced", "the tower slices");
  const first = await pressGcodeTile(page);
  assert(first !== null, "a fresh result exports its G-code");
  await prepareAndSelect(page);
  let before = await look(page);
  assert(before.readiness === "sliced" && before.gcodeDisabled === false, "back in Prepare, the result is still fresh", JSON.stringify(before));

  // 02 first: the toolbar takes its arrows, so nothing moves and nothing goes stale.
  await page.locator('[data-levo-tool="move"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(600);
  let after = await look(page);
  assert(after.focus === "rotate", "ArrowLeft on «تحريك» moves the focus to «تدوير» (right to left)", String(after.focus));
  assert(after.x === before.x, "…and moves no model", `x ${before.x} -> ${after.x}`);
  assert(after.readiness === "sliced" && after.gcodeDisabled === false, "…and the result stays fresh", after.readiness);
  await page.keyboard.press("End");
  assert((await look(page)).focus === "auto-arrange-phone", "End reaches «ترتيب»");
  await page.keyboard.press("Home");
  assert((await look(page)).focus === "move", "Home comes back to «تحريك»");
  const stops = await page.evaluate(() => [...document.querySelectorAll('.m-tools button')].map((b) => b.tabIndex));
  assert(stops.filter((value) => value === 0).length === 1 && stops[0] === 0, "the toolbar is one tab stop, on the focused tile", stops.join(","));
  await page.keyboard.press("ArrowDown");
  after = await look(page);
  assert(after.x === before.x && after.readiness === "sliced", "ArrowDown walks too, and moves nothing", `${after.focus}, x ${after.x}`);

  // 12: the viewport card's own toolbar takes its arrows too (c6fix-r3-ha-04).
  await page.locator('[data-levo-action="viewport-expand"]').focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(600);
  after = await look(page);
  assert(after.focus === "reset-view", "ArrowLeft on expand moves the focus to «إعادة العرض» (right to left)", String(after.focus));
  assert(after.x === before.x && after.readiness === "sliced" && after.gcodeDisabled === false, "…and moves no model: the result stays fresh", `x ${after.x}, ${after.readiness}`);
  await page.keyboard.press("ArrowRight");
  assert((await look(page)).focus === "viewport-expand", "ArrowRight comes back to expand");
  await page.keyboard.press("End");
  after = await look(page);
  assert(after.focus === "view-bed", "End reaches the bed view", String(after.focus));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(600);
  after = await look(page);
  assert(after.focus === "reset-view" && after.x === before.x && after.readiness === "sliced", "ArrowDown at the end and ArrowUp stay in the toolbar and move nothing", `${after.focus}, x ${after.x}, ${after.readiness}`);
  const overlayStops = await page.evaluate(() => [...document.querySelectorAll(".vp-overlay button")].map((b) => b.tabIndex));
  assert(overlayStops.filter((value) => value === 0).length === 1, "the viewport toolbar is one tab stop", overlayStops.join(","));

  // 01: an arrow on «المزيد» reaches the engine's nudge on window.
  await page.locator('[data-levo-action="more"]').focus();
  await page.keyboard.press("ArrowLeft");
  await waitForReadiness(page, "stale");
  after = await look(page);
  assert(after.x === before.x - 10, "ArrowLeft on «المزيد» moves the model 10 mm (the engine's own nudge)", `x ${before.x} -> ${after.x}`);
  assert(after.readiness === "stale", "…and the banner says the result is outdated", String(after.readiness));
  assert(after.gcodeDisabled === true && after.slice === "stale", "…the G-code tile is disabled and the primary is «أعد التقطيع»", `${after.gcodeDisabled} / ${after.slice}`);
  assert(await pressGcodeTile(page) === null, "…and nothing is downloaded");
  await shot(page, "shell-keys-stale-ar-dark.png");

  // 01: the same with the focus on the G-code tile itself.
  await slice(page);
  await prepareAndSelect(page);
  before = await look(page);
  assert(before.readiness === "sliced" && before.gcodeDisabled === false, "sliced again: fresh", JSON.stringify(before));
  await page.locator('[data-levo-action="export-gcode"]').focus();
  await page.keyboard.press("ArrowLeft");
  await waitForReadiness(page, "stale");
  after = await look(page);
  assert(after.x === before.x - 10 && after.readiness === "stale" && after.gcodeDisabled === true, "ArrowLeft on the G-code tile itself: moved, outdated, disabled", JSON.stringify(after));

  // 01: a key still held down. The engine nudges on keydown; until the keyup
  // nothing has told the shell, so the tile is pressed while the banner may
  // still say «جاهزة». The export reads the scene again and refuses.
  await slice(page);
  await prepareAndSelect(page);
  before = await look(page);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  await page.waitForTimeout(300);
  const held = await look(page);
  assert(held.x === before.x - 10, "a keydown with no keyup still nudges the model", `x ${before.x} -> ${held.x}`);
  const download = await pressGcodeTile(page);
  await page.waitForTimeout(300);
  after = await look(page);
  assert(download === null, "pressing the tile then downloads nothing", held.gcodeDisabled ? "(the tile was already disabled)" : "(the tile was enabled: the export itself refused)");
  assert(after.readiness === "stale" && after.gcodeDisabled === true, "…and the banner and the tile catch up: outdated, disabled", `${after.readiness} / ${after.gcodeDisabled}`);
  await ctx.close();
}

// =========================================================================
// 03 + 04 + 05 + 07 — THE SETTINGS SHEET
// =========================================================================
for (const [lang, theme] of [["ar", "dark"], ["ckb", "light"], ["en", "dark"]]) {
  console.log(`\n03/04/05/07: the Settings sheet (${lang}, ${theme})`);
  const { ctx, page } = await openStudio(lang, theme);
  await openMore(page, "settings");
  const sw = page.getByRole("switch");
  const name = await page.locator('[role="switch"]').evaluate((element) => {
    const id = element.getAttribute("aria-labelledby");
    return id ? document.getElementById(id)?.textContent.trim() ?? "" : element.getAttribute("aria-label") ?? "";
  });
  const expected = { ar: "الدعامات", ckb: "پاڵپشتەکان", en: "Support" }[lang];
  assert(name === expected, "the support switch is named by its label", name);
  assert(await sw.count() === 1 && await page.getByRole("switch", { name: expected }).count() === 1, "…and the accessibility tree finds it by that name");
  const box = await page.locator('[role="switch"]').boundingBox();
  assert(box && box.width >= 44 && box.height >= 44, "…in a 44 px box", box ? `${Math.round(box.width)} x ${Math.round(box.height)}` : "none");

  // 05: radiogroups, one checked, with the check mark.
  const groups = await page.evaluate(() => [...document.querySelectorAll('.setup-body [role="radiogroup"]')].map((group) => ({
    label: group.getAttribute("aria-label"),
    radios: [...group.querySelectorAll('[role="radio"]')].map((radio) => ({
      text: radio.textContent.trim(), checked: radio.getAttribute("aria-checked"), tab: radio.tabIndex, mark: Boolean(radio.querySelector(".tier-check, svg")),
    })),
  })));
  for (const group of groups) {
    const checked = group.radios.filter((radio) => radio.checked === "true");
    assert(checked.length === 1, `«${group.label}» has exactly one checked option`, checked.map((radio) => radio.text).join(" | "));
    assert(group.radios.filter((radio) => radio.tab === 0).length === 1 && checked[0]?.tab === 0, `«${group.label}» is one tab stop, on the checked option`);
    assert(checked[0]?.mark === true, `«${group.label}»: the checked option carries the check mark`);
  }
  assert(groups.length >= 5, "mode, quality, strength, infill pattern and appearance are radiogroups", groups.map((group) => group.label).join(" · "));

  // 07: the tier words are the reader's language.
  const tiers = await page.evaluate(() => [...document.querySelectorAll('.setup-body [data-levo-tier] strong')].map((strong) => strong.textContent.trim()));
  const captions = await page.evaluate(() => [...document.querySelectorAll('.setup-body [data-levo-tier] span')].map((span) => span.textContent.trim()));
  const qualityAndStrength = tiers.slice(0, 6);
  if (lang === "en") {
    assert(qualityAndStrength.join(",") === "Fine,Standard,Draft,Light,Standard,Strong", "English keeps Fine / Standard / Draft and Light / Standard / Strong", qualityAndStrength.join(" · "));
    assert(captions.slice(3, 6).every((caption) => /walls?$/.test(caption)), "…and counts the walls in English", captions.slice(3, 6).join(" · "));
  } else {
    assert(qualityAndStrength.every((word) => !/[A-Za-z]/.test(word)), "the Quality and Strength tiers carry no English", qualityAndStrength.join(" · "));
    assert(captions.slice(3, 6).every((caption) => !/[A-Za-z]/.test(caption.replace(/%/g, ""))), "…and the walls are counted in the reader's language", captions.slice(3, 6).join(" · "));
  }
  assert(tiers.slice(6).join(",") === "Zigzag,Gyroid,3D Honeycomb", "the infill patterns keep the engine's own names", tiers.slice(6).join(" · "));

  // 04 + 05: the arrows walk the tiers, choosing as they go, and stop at the group.
  const quality = page.locator('.setup-body [role="radiogroup"]').nth(1);
  await quality.locator('[aria-checked="true"]').focus();
  // The tier rows are drawn left to right in every language (.segmented-control is direction: ltr).
  await page.keyboard.press("ArrowRight");
  let focus = await focusInfo(page);
  assert(focus.role === "radio" && focus.checked === "true" && focus.tab === 0, "ArrowRight on a tier moves to the next one and checks it", focus.text);
  await page.keyboard.press("Home");
  focus = await focusInfo(page);
  assert(focus.checked === "true" && /0\.12/.test(focus.text), "Home goes to the first tier", focus.text);
  await page.keyboard.press("End");
  focus = await focusInfo(page);
  assert(focus.checked === "true" && /0\.24/.test(focus.text), "End goes to the last tier", focus.text);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  focus = await focusInfo(page);
  assert(/0\.12/.test(focus.text) && await page.locator(".studio-sheet").count() === 1, "and the sheet stays open around it", focus.text);
  // The mode radiogroup in the sheet.
  const mode = page.locator(".mode-control");
  await mode.locator('[aria-checked="true"]').focus();
  await page.keyboard.press("End");
  focus = await focusInfo(page);
  assert(focus.checked === "true" && focus.tab === 0 && await page.locator('[data-levo-mode-choice="advanced"][aria-checked="true"]').count() === 1, "End in the mode radiogroup chooses Advanced, on the page too", focus.text);
  await page.keyboard.press("Home");
  assert(await page.locator('[data-levo-mode-choice="simple"][aria-checked="true"]').count() === 1, "Home brings Simple back");
  await shot(page.locator(".setup-body"), `shell-keys-settings-${lang}-${theme}.png`);
  await closeSheet(page);

  // 04: the printer grid, opened from the «الطابعة» row.
  await page.locator('[data-levo-card="print-settings"] button[aria-haspopup="dialog"]').first().click();
  await page.waitForTimeout(800);
  const radios = page.locator('.printer-choice-body [role="radio"]');
  const tabStops = await radios.evaluateAll((all) => all.filter((radio) => radio.tabIndex === 0).length);
  assert(await radios.count() === 14 && tabStops === 1, "the printer grid: 14 radios, one tab stop", `${tabStops} tab stop(s)`);
  await page.locator('.printer-choice-body [aria-checked="true"]').focus();
  await page.keyboard.press("ArrowDown");
  focus = await focusInfo(page);
  assert(/A1 mini/.test(focus.text) && focus.checked === "true", "ArrowDown drafts the next printer (A1 mini after A1)", focus.text);
  await page.keyboard.press("End");
  focus = await focusInfo(page);
  assert(/A2L/.test(focus.text) && focus.checked === "true", "End drafts the last one", focus.text);
  assert(await page.locator(".printer-choice-body .sheet-done").isEnabled(), "«تطبيق» still confirms");
  await closeSheet(page);

  // 04: the connection tabs.
  await openMore(page, "connect");
  const tabs = page.locator('.connection-method-tabs [role="tab"]');
  await page.locator('.connection-method-tabs [aria-selected="true"]').focus();
  await page.keyboard.press("ArrowRight");
  focus = await focusInfo(page);
  assert(focus.role === "tab" && focus.selected === "true" && focus.tab === 0, "ArrowRight selects the next connection tab", focus.text);
  await page.keyboard.press("End");
  focus = await focusInfo(page);
  assert(focus.selected === "true" && /USB/.test(focus.text), "End selects USB", focus.text);
  const wiring = await page.evaluate(() => {
    const tab = document.querySelector('.connection-method-tabs [aria-selected="true"]');
    const panel = document.getElementById(tab?.getAttribute("aria-controls") ?? "");
    return { panel: panel?.getAttribute("role") ?? null, labelledBy: panel?.getAttribute("aria-labelledby") === tab?.id, stops: [...document.querySelectorAll('.connection-method-tabs [role="tab"]')].filter((t) => t.tabIndex === 0).length };
  });
  assert(await tabs.count() === 3 && wiring.panel === "tabpanel" && wiring.labelledBy && wiring.stops === 1, "each tab controls the tabpanel, which its tab labels; one tab stop", JSON.stringify(wiring));
  await closeSheet(page);
  await ctx.close();
}

// =========================================================================
// 06 — THE MESSAGE ROW COUNTS, AND NAMES NO ENGINE KEY
// =========================================================================
for (const [lang, theme, arranged, turned] of [
  ["ar", "dark", "تم ترتيب مجسم واحد على Plate واحدة.", "تم تغيير اتجاه مجسم واحد."],
  ["en", "dark", "Arranged 1 object across 1 plate.", "Turned 1 object."],
  ["ckb", "light", "1 تەن لەسەر 1 Plate ڕیز کرا.", "ئاراستەی 1 تەن گۆڕدرا."],
]) {
  console.log(`\n06: the message row (${lang}, ${theme})`);
  const { ctx, page } = await openStudio(lang, theme);
  await load(page, CUBE);
  await page.locator('[data-levo-action="auto-arrange-phone"]').click();
  await page.waitForTimeout(1500);
  let message = (await look(page)).message;
  assert(message.includes(arranged), "«ترتيب» says the count in words that agree with it", message.slice(0, 120));
  await dismissMessages(page);
  await page.locator('[data-levo-orient="side"]').click();
  await page.waitForTimeout(2500);
  message = (await look(page)).message;
  assert(message.includes(turned), "the orientation chip counts the object", message.slice(0, 120));
  await dismissMessages(page);

  if (lang !== "en") {
    // A hand edit the preset takes back: Advanced, «كل الإعدادات», type 0.16
    // into the engine's Layer height, then pick 0.12 in the layer row.
    await page.locator('[data-levo-mode-choice="advanced"]').click();
    await page.waitForTimeout(800);
    await page.locator('[data-levo-action="all-settings"]').click();
    await page.waitForTimeout(1500);
    const row = page.locator('[data-testid="row-layer_height"] input').first();
    await row.click({ clickCount: 3 });
    await page.keyboard.type("0.16");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await dismissMessages(page);
    await page.selectOption("#m-layer", "fine");
    await page.waitForTimeout(3500);
    message = (await look(page)).message;
    assert(message.length > 0 && !/layer_height|[a-z]+_[a-z]+/.test(message), "the preset that took an edit back says how many, and names no engine key", message.slice(0, 160));
    await shot(page.locator(".studio-messages"), `shell-keys-took-edits-${lang}-${theme}.png`);
  }
  await ctx.close();
}

// =========================================================================
// 08 — THE ABOUT SHEET'S LEGAL TARGETS
// =========================================================================
console.log("\n08: the About sheet (ar, dark)");
{
  const { ctx, page } = await openStudio("ar", "dark");
  await openMore(page, "about");
  const summary = await page.locator(".legal-details summary").boundingBox();
  assert(summary && summary.height >= 44, "«المعلومات القانونية» is at least 44 px tall", summary ? `${Math.round(summary.width)} x ${Math.round(summary.height)}` : "none");
  await page.locator(".legal-details summary").click();
  await page.waitForTimeout(300);
  const link = await page.locator(".legal-details a").boundingBox();
  assert(link && link.height >= 44, "«المصدر وإشعارات المكتبات» is at least 44 px tall", link ? `${Math.round(link.width)} x ${Math.round(link.height)}` : "none");
  await ctx.close();
}

// =========================================================================
// 09 — AN UNDO OFFER STANDS ONLY OVER THE OBJECTS IT WAS RAISED OVER
// =========================================================================
/** A two-part ZIP built here from the cube, so no archive is kept in the repository. */
const { zipSync } = require("fflate");
const cubeBytes = readFileSync(CUBE);
const TWO_PARTS = { name: "two-parts.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "part-a.stl": new Uint8Array(cubeBytes), "part-b.stl": new Uint8Array(cubeBytes) })) };
const sceneNames = (page) => page.evaluate(() => window.__vpApi().sceneSnapshot().map((entry) => entry.name ?? String(entry.id)).sort());
async function moreAction(page, action) {
  await page.locator('[data-levo-action="more"]').click();
  await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
  await page.locator(`[data-levo-more="${action}"]`).click();
  await page.waitForTimeout(1200);
}
async function cutSelected(page) {
  await page.evaluate(() => { const api = window.__vpApi(); api.selectObject?.(api.sceneSnapshot()[0]?.id); });
  await page.waitForTimeout(300);
  await moreAction(page, "cut");
  await page.locator('[data-levo-cut="apply"]').click();
  await page.waitForTimeout(2000);
}
for (const [lang, theme, offer, cutSaid, undoneSaid, zipSaid] of [
  ["ar", "dark", "تراجع عن القص", "تم القص إلى قطعتين.", "تم التراجع عن القص.", "تم توزيع مجسمين تلقائيًا على Plate واحدة."],
  ["ckb", "light", "گەڕاندنەوەی بڕین", "بۆ 2 پارچە بڕدرا.", null, "2 تەن بە شێوەی خۆکار لەسەر 1 Plate دابەش کران."],
  ["en", "dark", "Undo the cut", "Cut into 2 pieces.", null, "Automatically arranged 2 models across 1 plate."],
]) {
  console.log(`\n09: the undo offer and the counted notices (${lang}, ${theme})`);
  const { ctx, page } = await openStudio(lang, theme);
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  const offerButton = () => page.locator(".studio-messages button", { hasText: offer });
  await load(page, CUBE);
  await cutSelected(page);
  let message = (await look(page)).message;
  assert(message.includes(cutSaid), "the cut says how many pieces in words that agree", message.slice(0, 120));
  assert(await offerButton().count() === 1, `«${offer}» is offered after the cut`);
  // Nothing else changed: the offer undoes the cut.
  await offerButton().click();
  await page.waitForTimeout(1500);
  let names = await sceneNames(page);
  message = (await look(page)).message;
  assert(names.length === 1 && (!undoneSaid || message.includes(undoneSaid)), "pressed at once, it brings the cube back", `${names.join(", ")} | ${message.slice(0, 80)}`);
  // A duplicate takes the offer down.
  await cutSelected(page);
  assert(await offerButton().count() === 1, "cut again: offered again");
  await page.evaluate(() => { const api = window.__vpApi(); api.selectObject?.(api.sceneSnapshot()[0]?.id); });
  await moreAction(page, "duplicate");
  names = await sceneNames(page);
  assert(names.length === 3 && await offerButton().count() === 0, "a duplicate takes the offer down", `${names.length} objects, offer ${await offerButton().count()}`);
  await dismissMessages(page);
  // Delete all, then a ZIP import: the offer never comes back, and the parts stay.
  await cutSelected(page);
  assert(await offerButton().count() === 1, "cut a third time: offered");
  await moreAction(page, "delete-all");
  await page.waitForTimeout(800);
  assert(await offerButton().count() === 0, "«حذف الكل» takes the offer down", (await look(page)).message.slice(0, 80));
  await page.setInputFiles("input.native-file-input >> nth=0", TWO_PARTS, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length >= 2, null, { timeout: 90_000 });
  await page.waitForTimeout(3000);
  names = await sceneNames(page);
  message = (await look(page)).message;
  assert(names.join(",") === "part-a.stl,part-b.stl", "the two parts arrive", names.join(", "));
  assert(message.includes(zipSaid), "the ZIP notice counts the parts in the reader's language", message.slice(0, 120));
  assert(await offerButton().count() === 0, "and no undo offer stands next to it, so nothing can delete the parts");
  await shot(page.locator(".studio-messages"), `shell-keys-undo-offer-${lang}-${theme}.png`);
  await ctx.close();
}

// =========================================================================
// 10 + 11 — THE PROJECTS TABS AND THE CONNECTION TABS
// =========================================================================
/** Colour helpers for the two measures below, spelled once and run inside the page. */
const COLOURS = String.raw`
  const parse = (value) => { const m = String(value).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const over = (top, under) => (top.a >= 1 ? top : { r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const behind = (element) => { const chain = []; for (let e = element; e; e = e.parentElement) chain.push(e); let c = { r: 255, g: 255, b: 255, a: 1 }; for (const e of chain.reverse()) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg && bg.a > 0) c = over(bg, c); } return c; };
  const fills = (element) => { const image = getComputedStyle(element).backgroundImage; const stops = image && image !== "none" ? [...image.matchAll(/rgba?\([^)]+\)/g)].map((m) => over(parse(m[0]), behind(element))) : []; return stops.length ? stops : [behind(element)]; };
`;
const PROJECT_TABS = String.raw`(() => {${COLOURS}
  const list = document.querySelector(".levo-projects-panel .lpp-tabs");
  const named = (list?.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() ?? "").join(" ").trim() || list?.getAttribute("aria-label") || "";
  return {
    name: named,
    tabs: [...(list?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => {
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      return {
        text: tab.textContent.trim(), selected: tab.getAttribute("aria-selected"), tab: tab.tabIndex, h: Math.round(tab.getBoundingClientRect().height),
        contrast: Math.min(...fills(tab).map((fill) => ratio(parse(getComputedStyle(tab).color), fill))),
        panel: panel?.getAttribute("role") ?? null, labelledBy: panel?.getAttribute("aria-labelledby") ?? null, id: tab.id,
      };
    }),
  };
})()`;
const CONNECT_TAB = String.raw`(() => {${COLOURS}
  const tab = document.querySelector('.connection-method-tabs [aria-selected="true"]');
  const span = tab.querySelector("span");
  const track = behind(tab.parentElement);
  const ring = getComputedStyle(tab).boxShadow.match(/(rgba?\([^)]+\)) 0px 0px 0px 1px(?! inset)/)?.[1];
  const edge = ring ? ratio(over(parse(ring), track), track) : 0;
  return {
    text: tab.textContent.trim(),
    check: Boolean(tab.querySelector('svg path[d="m5 12 4 4L19 6"]')),
    others: document.querySelectorAll('.connection-method-tabs [aria-selected="false"] svg path[d="m5 12 4 4L19 6"]').length,
    label: Math.min(...fills(tab).map((fill) => ratio(parse(getComputedStyle(span).color), fill))),
    boundary: Math.max(edge, Math.min(...fills(tab).map((fill) => ratio(fill, track)))),
    // The lines the name needs, measured with the two-line clamp lifted.
    lines: (() => {
      const kept = span.getAttribute("style");
      span.style.display = "block";
      span.style.webkitLineClamp = "unset";
      const needed = Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight));
      if (kept === null) span.removeAttribute("style"); else span.setAttribute("style", kept);
      return needed;
    })(),
  };
})()`;
for (const [lang, theme] of [["ar", "dark"], ["ckb", "light"], ["en", "dark"]]) {
  console.log(`\n10/11: the Projects tabs and the connection tabs (${lang}, ${theme})`);
  const { ctx, page } = await openStudio(lang, theme);
  await openMore(page, "projects");
  const tabs = await page.evaluate(PROJECT_TABS);
  const chosen = tabs.tabs.find((tab) => tab.selected === "true");
  assert(tabs.name.length > 0, "the Projects tablist is named", tabs.name);
  assert(tabs.tabs.length === 2 && tabs.tabs.every((tab) => tab.h >= 44), "both Projects tabs are 44 px tall", tabs.tabs.map((tab) => tab.h).join(","));
  assert(chosen && chosen.contrast >= 4.5, "the chosen tab reads ink on the sand at 4.5:1 or more", chosen ? `${chosen.text}: ${chosen.contrast}:1` : "none");
  assert(tabs.tabs.filter((tab) => tab.tab === 0).length === 1 && chosen?.tab === 0, "one tab stop, on the chosen tab");
  assert(chosen?.panel === "tabpanel" && chosen?.labelledBy === chosen?.id, "the chosen tab controls the tabpanel it labels", JSON.stringify(chosen));
  const xBefore = await page.evaluate(() => window.__vpApi().sceneSnapshot()[0]?.pos.x ?? null);
  await page.locator('.levo-projects-panel .lpp-tabs [aria-selected="true"]').focus();
  await page.keyboard.press("Home");
  let focus = await focusInfo(page);
  assert(focus.role === "tab" && focus.selected === "true" && focus.tab === 0, "Home chooses the account tab", focus.text);
  await page.keyboard.press("End");
  focus = await focusInfo(page);
  assert(focus.selected === "true" && focus.text === chosen?.text, "End comes back to the device drafts", focus.text);
  assert(await page.locator(".studio-sheet").count() === 1 && xBefore === await page.evaluate(() => window.__vpApi().sceneSnapshot()[0]?.pos.x ?? null), "the sheet stays open, and nothing behind it moved");
  await shot(page.locator(".levo-projects-panel .lpp-header"), `shell-keys-projects-tabs-${lang}-${theme}.png`);
  await closeSheet(page);

  await openMore(page, "connect");
  const connect = await page.evaluate(CONNECT_TAB);
  assert(connect.check && connect.others === 0, "the chosen connection way carries the check mark, and only it", connect.text);
  assert(connect.label >= 4.5, "its label is 4.5:1 or more on the sand", `${connect.label}:1`);
  assert(connect.boundary >= 3, "its edge or fill is 3:1 or more against the track", `${connect.boundary}:1`);
  assert(connect.lines <= 2, "its name fits the two lines it may take, so nothing is cut short", `${connect.text} on ${connect.lines} line(s)`);
  await shot(page.locator(".connection-method-tabs"), `shell-keys-connect-tabs-${lang}-${theme}.png`);
  await closeSheet(page);
  await ctx.close();
}

assert(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));
await browser.close();

writeFileSync(REPORT_PATH, JSON.stringify({ target, viewport: PHONE, failures, checks }, null, 2) + "\n");
console.log(`\nshell-keys: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
