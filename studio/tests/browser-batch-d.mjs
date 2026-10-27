#!/usr/bin/env node
/**
 * THE OWNER'S STUDIO ITEMS, IN A REAL BROWSER.
 *
 * The unit tests pin the source. This drives the built app, on a phone-sized
 * viewport, because three of these items are only true if the browser agrees:
 *
 *   9a  a first visit is ASKED which printer, with nothing pre-selected, and
 *       the confirm is unpressable until something is tapped
 *       («من دخلت اختارلي x2d مباشرة»);
 *   9a  the answer survives a reload, and so does a DECLINE — the sheet must
 *       not greet the same person on every visit;
 *   9b  the infill control exists under Strength and offers three patterns;
 *   10  the tool tray really gets shorter, and nothing disappears when it does
 *       («زر تقصير وتطويل قائمة الادوات»);
 *   C6  a tap on an open sheet's backdrop closes the sheet and reaches
 *       nothing under it: not the back chevron, «حفظ» or «استيراد».
 *
 * NOT part of `npm test`: it needs a built Studio, a server, and Chromium.
 *
 *   cd studio && npm run build
 *   npx wrangler dev --port 8799 --ip 127.0.0.1 --compatibility-date 2026-05-22
 *   node tests/browser-batch-d.mjs
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-batch-d.latest.json");
const TOWER = join(STUDIO_ROOT, "tests", "fixtures", "tower-8x8x90.stl");
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
if (!chromium) { console.error("batch-d: no playwright available"); process.exit(1); }

const PHONE = { width: 390, height: 844 };
const PRINTER_KEY = "levo-studio-printer";

const checks = [];
let failures = 0;
const fail = (m, detail) => { failures++; checks.push({ ok: false, m, detail }); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ""}`); };
const ok = (m, detail) => { checks.push({ ok: true, m, detail }); console.log(`  ok   ${m}${detail ? ` — ${detail}` : ""}`); };
const assert = (cond, m, detail) => (cond ? ok(m, detail) : fail(m, detail));

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

/** A context with an empty origin storage — a genuine first visit. */
async function freshPage() {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

const readPrinterKey = (page) => page.evaluate((key) => window.localStorage.getItem(key), PRINTER_KEY);

// =========================================================================
// 9a — THE FIRST VISIT IS ASKED
// =========================================================================
console.log("\nfirst visit: the printer is asked for");
{
  const { ctx, page } = await freshPage();

  const sheetOpen = await page.locator(".studio-sheet").isVisible().catch(() => false);
  assert(sheetOpen, "a sheet is open on the very first visit");

  const cards = page.locator(".printer-choice-body .profile-grid button");
  const cardCount = await cards.count();
  assert(cardCount >= 5, "the chooser lists the printers", `${cardCount} cards`);

  const preselected = await page.locator(".printer-choice-body .profile-grid button.active").count();
  assert(preselected === 0, "NOTHING is pre-selected — «اختارلي x2d مباشرة» is the bug", `${preselected} active`);

  const confirm = page.locator(".printer-choice-body .sheet-done");
  assert(await confirm.isDisabled(), "the confirm cannot be pressed before a choice exists");
  assert((await readPrinterKey(page)) === null, "and nothing has been stored yet");

  // Pick a printer that is NOT the seed, so a stored X2D would be visible.
  let picked = -1;
  for (let i = 0; i < cardCount; i += 1) {
    const text = (await cards.nth(i).innerText()).trim();
    if (/A1 mini/i.test(text)) { picked = i; break; }
  }
  assert(picked >= 0, "the A1 mini is offered", `index ${picked}`);
  await cards.nth(picked).click();
  await page.waitForTimeout(200);

  assert(await page.locator(".printer-choice-body .profile-grid button.active").count() === 1, "the tapped card becomes the only active one");
  assert(!(await confirm.isDisabled()), "and the confirm is now pressable");

  await confirm.click();
  await page.waitForTimeout(500);
  assert(!(await page.locator(".studio-sheet").isVisible().catch(() => false)), "confirming closes the chooser");

  const stored = await readPrinterKey(page);
  assert(stored === "bbl-a1m-04", "the choice is what was stored", String(stored));

  // And it survives a reload without asking again.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  assert(!(await page.locator(".printer-choice-body").isVisible().catch(() => false)), "a second visit is not asked again");
  assert((await readPrinterKey(page)) === "bbl-a1m-04", "and the printer is still the chosen one");

  // =======================================================================
  // 9b — THE INFILL CONTROL, UNDER STRENGTH
  // =======================================================================
  console.log("\nthe infill control");
  // CHANGED DELIBERATELY (plan item C6): on a phone the desktop header, and
  // its `.profile-button`, are hidden. The printer is a row on the page's
  // print-settings card, and the Setup sheet is one tap into the overflow.
  const printerRow = page.locator('[data-levo-card="print-settings"] button[aria-haspopup="dialog"]');
  assert(await printerRow.isVisible(), "the page's printer row is reachable");
  assert(
    /A1 mini|A1M/i.test((await printerRow.innerText()).replace(/\s+/g, " ")),
    "and it already shows the printer that was chosen, not the seed",
    (await printerRow.innerText()).replace(/\s+/g, " "),
  );
  await page.locator('[data-levo-action="more"]').click();
  await page.locator('[data-levo-more="settings"]').click();
  await page.waitForTimeout(700);

  const legends = await page.locator(".setup-body legend").allInnerTexts();
  assert(legends.length >= 4, "the setup sheet has printer / quality / strength / infill", legends.join(" | "));

  // Found by what it offers, not by position: the sheet also carries the
  // mode (first) and the appearance (last).
  const groups = page.locator(".setup-body fieldset");
  const infillIndex = await groups.evaluateAll((sets) => sets.findIndex((set) => /Gyroid/.test(set.textContent ?? "")));
  assert(infillIndex > 0, "the infill group is in the sheet", `index ${infillIndex}`);
  const infill = groups.nth(infillIndex);
  const infillButtons = infill.locator(".segmented-control button");
  assert(await infillButtons.count() === 3, "the infill group offers exactly three patterns", `${await infillButtons.count()} buttons`);

  const patternLabels = (await infill.locator(".segmented-control button strong").allInnerTexts()).map((s) => s.trim());
  assert(new Set(patternLabels).size === 3, "three distinct pattern names", patternLabels.join(" / "));

  // And it really is UNDER Strength, not beside it.
  const strengthBox = await groups.nth(infillIndex - 1).boundingBox();
  const infillBox = await infill.boundingBox();
  assert(infillBox.y > strengthBox.y, "«تظيف قائمة اسفل قائمة القوة» — under Strength", `${Math.round(strengthBox.y)} -> ${Math.round(infillBox.y)}`);

  await infillButtons.nth(2).click();
  await page.waitForTimeout(500);
  assert(await infill.locator(".segmented-control button.active").count() === 1, "the chosen pattern is the only active one");
  assert(
    (await infillButtons.nth(2).getAttribute("class") || "").includes("active"),
    "and it is the one that was tapped",
    patternLabels[2],
  );
  await ctx.close();
}

// =========================================================================
// 9a — A DISMISSAL IS AN ANSWER
// =========================================================================
console.log("\ndeclining the question");
{
  const { ctx, page } = await freshPage();
  assert(await page.locator(".printer-choice-body").isVisible().catch(() => false), "the chooser opens on a clean first visit");
  await page.locator(".sheet-head button, .studio-sheet header button").last().click();
  await page.waitForTimeout(500);
  assert(!(await page.locator(".printer-choice-body").isVisible().catch(() => false)), "closing it works");

  const stored = await readPrinterKey(page);
  assert(stored !== null, "the decline is recorded", String(stored));
  assert(stored !== "bbl-x2d-04", "and it is NOT recorded as a printer the person never chose", String(stored));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  assert(!(await page.locator(".printer-choice-body").isVisible().catch(() => false)), "and the sheet does not greet them again");
  await ctx.close();
}

// =========================================================================
// 10 — THE OVERFLOW HOLDS EVERY TOOL, AND THE VIEW EXPANDS AND COMES BACK
// =========================================================================
// CHANGED DELIBERATELY (plan item C6). The phone had a tool tray that could be
// shortened so the bed showed behind it («زر تقصير وتطويل قائمة الادوات»). The
// reference column gives the bed its own card instead, with an expand button
// for the full-screen view, and moves every tool the tray held into the
// overflow sheet. What this section keeps checking is the promise: nothing is
// out of reach, and the bed can be seen in full.
console.log("\nthe overflow holds every tool; the view expands and comes back");
{
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  }, [PRINTER_KEY, "bbl-x2d-04"]);
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  await page.locator('[data-levo-action="more"]').click();
  await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
  const tools = await page.evaluate(() => [...document.querySelectorAll("[data-levo-more]")].map((el) => el.getAttribute("data-levo-more")));
  for (const tool of ["projects", "new-project", "duplicate", "split", "on-bed", "paint", "cut", "auto-orient", "delete", "add-plate", "delete-all",
    "toggle-preview", "zoom-all", "zoom-bed", "undo", "redo", "makerworld", "settings", "all-settings", "connect", "about", "source"]) {
    assert(tools.includes(tool), `the overflow carries «${tool}»`);
  }
  const source = await page.locator('[data-levo-more="source"]').getAttribute("href");
  assert(/^https:\/\/github\.com\//.test(source ?? ""), "the AGPL source link is two taps from the main screen", source);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const card = page.locator(".editor-area");
  const cardBox = await card.boundingBox();
  await page.locator('[data-levo-action="viewport-expand"]').click();
  await page.waitForTimeout(500);
  const fullBox = await card.boundingBox();
  assert(fullBox.height >= PHONE.height - 1 && fullBox.width >= PHONE.width - 1, "expand gives the bed the whole screen", `${Math.round(cardBox.height)}px -> ${Math.round(fullBox.height)}px`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const backBox = await card.boundingBox();
  assert(Math.abs(backBox.height - cardBox.height) < 2, "and Escape brings the card back", `${Math.round(backBox.height)}px`);
  await ctx.close();
}

// =========================================================================
// C6 — A TAP ON A SHEET'S BACKDROP CLOSES THE SHEET, AND ONLY THE SHEET
// =========================================================================
// c6fix-r1-ha-01: the backdrop closed the sheet on pointerdown. The click of
// a tap is hit-tested after pointerup, when the backdrop was already gone, so
// it landed on the top bar under it: the back chevron left the Studio and the
// model was lost, «حفظ» saved a draft, «استيراد» opened the file picker.
console.log("\na tap on a sheet's backdrop reaches nothing under it");
{
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  }, [PRINTER_KEY, "bbl-a1-04"]);
  let chooser = 0;
  page.on("filechooser", () => { chooser += 1; });
  await page.goto(target, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 90_000 });
  await page.setInputFiles("input.native-file-input >> nth=0", TOWER, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  const dismiss = page.locator(".studio-messages .editor-message button[aria-label]");
  if (await dismiss.count()) await dismiss.last().click();
  await page.waitForTimeout(300);
  const home = page.url();
  const look = () => page.evaluate(() => ({
    url: location.href,
    sheet: Boolean(document.querySelector(".studio-sheet")),
    message: document.querySelector(".studio-messages")?.textContent.trim() ?? "",
    objects: (() => { try { return window.__vpApi().sceneSnapshot().length; } catch { return null; } })(),
  }));
  const points = await page.evaluate(() => Object.fromEntries([
    ["the back chevron", ".m-topbar__back"],
    ["«حفظ»", '[data-levo-action="save-now"]'],
    ["«استيراد»", ".m-topbar .m-btn--outline"],
  ].map(([name, selector]) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return [name, box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null];
  })));
  for (const [name, point] of Object.entries(points)) {
    assert(point !== null, `${name} is on the top bar`);
    if (!point) continue;
    await page.locator('[data-levo-action="more"]').click();
    await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className ?? null, [point.x, point.y]);
    assert(under === "sheet-backdrop", `with «المزيد» open, ${name} lies under the backdrop`, `(${point.x}, ${point.y}) ${under}`);
    const before = await look();
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(1200);
    const after = await look();
    assert(!after.sheet, `a tap there closes the sheet`, name);
    assert(after.url === home && after.objects === before.objects && after.objects > 0, `…and stays in the Studio with the model`, `${after.url} · ${after.objects} object(s)`);
    assert(after.message === before.message, `…and runs nothing under it: no save, no message`, after.message.slice(0, 80) || "(no message)");
    assert(chooser === 0, `…and opens no file picker`, `${chooser}`);
    if (after.sheet) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
  }
  // A mouse click on the backdrop still closes the sheet.
  await page.locator('[data-levo-action="more"]').click();
  await page.waitForSelector('[data-levo-sheet="more"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  const back = points["the back chevron"];
  if (back) await page.mouse.click(back.x, back.y);
  await page.waitForTimeout(800);
  const clicked = await look();
  assert(!clicked.sheet && clicked.url === home, "a mouse click on the backdrop closes the sheet too, and stays", clicked.url);
  await ctx.close();
}

await browser.close();

writeFileSync(REPORT_PATH, JSON.stringify({ target, viewport: PHONE, failures, checks }, null, 2) + "\n");
console.log(`\nbatch-d: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
