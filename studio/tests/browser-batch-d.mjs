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
 *       («زر تقصير وتطويل قائمة الادوات»).
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
  // `.profile-button` is the header control that opens the Setup sheet — it
  // shows the current printer's short name, which is also worth checking.
  const setupButton = page.locator(".profile-button");
  assert(await setupButton.isVisible(), "the header's setup control is reachable");
  assert(
    /A1 mini|A1M/i.test((await setupButton.innerText()).replace(/\s+/g, " ")),
    "and it already shows the printer that was chosen, not the seed",
    (await setupButton.innerText()).replace(/\s+/g, " "),
  );
  await setupButton.click();
  await page.waitForTimeout(700);

  const legends = await page.locator(".setup-body legend").allInnerTexts();
  assert(legends.length === 4, "the setup sheet has printer / quality / strength / infill", legends.join(" | "));

  const groups = page.locator(".setup-body fieldset");
  const groupCount = await groups.count();
  const infill = groups.nth(groupCount - 1);
  const infillButtons = infill.locator(".segmented-control button");
  assert(await infillButtons.count() === 3, "the last group offers exactly three patterns", `${await infillButtons.count()} buttons`);

  const patternLabels = (await infill.locator(".segmented-control button strong").allInnerTexts()).map((s) => s.trim());
  assert(new Set(patternLabels).size === 3, "three distinct pattern names", patternLabels.join(" / "));

  // And it really is UNDER Strength, not beside it.
  const strengthBox = await groups.nth(groupCount - 2).boundingBox();
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
// 10 — THE TOOL TRAY SHORTENS, AND HIDES NOTHING
// =========================================================================
console.log("\nthe tool tray shrinks and grows");
{
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  }, [PRINTER_KEY, "bbl-x2d-04"]);
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const opened = await page.evaluate(() => {
    const tools = [...document.querySelectorAll(".mobile-primarybar button")].find((b) => b.getAttribute("aria-expanded") !== null);
    if (!tools) return false;
    tools.click();
    return true;
  });
  assert(opened, "the Tools button opens the tray");
  await page.waitForTimeout(500);

  const tray = page.locator(".mobile-tooltray");
  assert(await tray.isVisible(), "the tray is on screen");
  const tallBox = await tray.boundingBox();
  const tallTools = await tray.locator(".mobile-toolgrid button, .mobile-toolgrid .file-select-control").count();

  await page.locator('[data-levo-action="tray-height"]').click();
  await page.waitForTimeout(500);
  const shortBox = await tray.boundingBox();
  const shortTools = await tray.locator(".mobile-toolgrid button, .mobile-toolgrid .file-select-control").count();

  assert(shortBox.height < tallBox.height - 40, "shortening really shortens it", `${Math.round(tallBox.height)}px -> ${Math.round(shortBox.height)}px`);
  assert(shortTools === tallTools, "and removes nothing — the tray still scrolls", `${tallTools} tools either way`);
  assert(await tray.locator("header").isVisible(), "the header stays put, so the control can be pressed again");

  await page.locator('[data-levo-action="tray-height"]').click();
  await page.waitForTimeout(500);
  const grownBox = await tray.boundingBox();
  assert(grownBox.height > shortBox.height + 40, "and it grows back", `${Math.round(shortBox.height)}px -> ${Math.round(grownBox.height)}px`);

  // More of the bed is visible when the tray is short. That is the point.
  assert(
    PHONE.height - shortBox.height > PHONE.height - tallBox.height,
    "more of the print bed shows behind it",
    `${Math.round(tallBox.height - shortBox.height)}px of bed recovered`,
  );
  await ctx.close();
}

await browser.close();

writeFileSync(REPORT_PATH, JSON.stringify({ target, viewport: PHONE, failures, checks }, null, 2) + "\n");
console.log(`\nbatch-d: ${checks.length - failures}/${checks.length} checks passed -> ${REPORT_PATH.slice(STUDIO_ROOT.length + 1)}`);
process.exit(failures ? 1 : 0);
