#!/usr/bin/env node
/**
 * Auto-orient, pressed in a real browser against a real build.
 *
 * tests/auto-orient.test.mjs proves the MATHS in Node. What it cannot prove is
 * the wiring: that the button exists, that the engine accepts the rotation the
 * shell writes, that the part does not sink into or float above the bed
 * afterwards, and that the undo really puts it back. Those are the four things
 * measured here, on an 8x8x90 tower — a cube would correctly not move at all
 * and so would prove nothing.
 *
 * THE FIXTURE IS Z-TALL ON PURPOSE. STL is Z-up and the engine converts to
 * three.js Y-up on import, so a part that is tall in the STL's Y arrives
 * already lying down — auto-orient then correctly does nothing, and a probe
 * written against it passes its height check for entirely the wrong reason.
 * That happened on the first run; the height of the part BEFORE the press is
 * now asserted too, so the test cannot pass vacuously again.
 *
 * NOT part of `npm test`: it needs a running Studio, a Chromium binary and
 * playwright-core. Run it by hand:
 *
 *   npm run build
 *   npx wrangler dev --local --port 8799 --ip 127.0.0.1   # in another shell
 *   node tests/browser-auto-orient.mjs                     # defaults to :8799
 *
 * Report written to tests/browser-auto-orient.latest.json.
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-auto-orient.latest.json");
const FIXTURE = join(STUDIO_ROOT, "tests", "fixtures", "tower-8x8x90.stl");
const target = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8799/";

const DEADLINE_MS = Number(process.env.BROWSER_DEADLINE_MS ?? 6 * 60 * 1000);
const deadline = setTimeout(() => {
  console.error("browser-auto-orient: deadline reached");
  process.exit(1);
}, DEADLINE_MS);
deadline.unref?.();

function findChromium() {
  const flag = process.argv.indexOf("--chromium");
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  if (existsSync(join(root, "chromium"))) return join(root, "chromium");
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium")) continue;
    for (const candidate of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome"]) {
      const full = join(root, entry, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * `require`, not `import`: playwright ships CommonJS, and an ESM import of an
 * absolute path to its index.js hands back a module whose `chromium` is
 * undefined — which is exactly the "Cannot read properties of undefined" this
 * probe hit the first time it ran.
 */
const require = createRequire(import.meta.url);
let chromium;
for (const specifier of ["playwright-core", "playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
  try {
    ({ chromium } = require(specifier));
    if (chromium) break;
  } catch {
    /* try the next one */
  }
}
if (!chromium) {
  console.error("browser-auto-orient: playwright is not installed.\n  npm i --no-save playwright-core");
  process.exit(1);
}

const executablePath = findChromium();
if (!executablePath) {
  console.error("browser-auto-orient: no Chromium binary found.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Where the object sits, as the ENGINE reports it — never as the shell hopes. */
const readScene = () =>
  (window.__vpApi?.()?.sceneSnapshot?.() ?? []).map((s) => ({
    id: s.id,
    rot: { x: s.rot.x, y: s.rot.y, z: s.rot.z },
    pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    // Lowest world Y, recomputed here from the engine's own numbers, so the
    // bed check does not trust the same code that moved the object.
    lowestY: (() => {
      const e = s.rot;
      const cx = Math.cos(e.x), sx = Math.sin(e.x);
      const cy = Math.cos(e.y), sy = Math.sin(e.y);
      const cz = Math.cos(e.z), sz = Math.sin(e.z);
      let lo = Infinity;
      for (let i = 0; i + 2 < s.localPos.length; i += 3) {
        const vx = s.localPos[i] * s.scale.x;
        const vy = s.localPos[i + 1] * s.scale.y;
        const vz = s.localPos[i + 2] * s.scale.z;
        const y = (cx * sz + sx * sy * cz) * vx + (cx * cz - sx * sy * sz) * vy + -sx * cy * vz;
        if (y < lo) lo = y;
      }
      return s.pos.y + lo;
    })(),
  }));

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

console.log(`\nAUTO-ORIENT in a browser — ${target}\n`);

await page.goto(target, { waitUntil: "load", timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 60_000 });
check("the editor mounts and exposes the engine", true);

await page.setInputFiles("input.native-file-input", FIXTURE, { timeout: 60_000 });
await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(2_000);

/** Height along the bed normal, from the engine's own numbers. */
const measureHeight = () => {
  const s = window.__vpApi().sceneSnapshot()[0];
  const e = s.rot;
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i + 2 < s.localPos.length; i += 3) {
    const vx = s.localPos[i] * s.scale.x, vy = s.localPos[i + 1] * s.scale.y, vz = s.localPos[i + 2] * s.scale.z;
    const y = (cx * sz + sx * sy * cz) * vx + (cx * cz - sx * sy * sz) * vy + -sx * cy * vz;
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  return hi - lo;
};

const before = await page.evaluate(readScene);
const heightBefore = await page.evaluate(measureHeight);
check("the tower imported", before.length === 1, `${before.length} objects`);
check("and arrives unrotated", Math.abs(before[0]?.rot.x ?? 9) < 1e-6 && Math.abs(before[0]?.rot.z ?? 9) < 1e-6,
  JSON.stringify(before[0]?.rot));
check("sitting on the bed", Math.abs(before[0]?.lowestY ?? 9) < 0.5, `lowestY ${before[0]?.lowestY}`);
// Without this the height check after the press can pass for the wrong reason:
// a part that arrived lying down is already short.
check("standing up, 90mm tall, before anything is pressed", heightBefore > 89,
  `height ${heightBefore.toFixed(2)}mm`);

// The button lives in the tool tray, which is collapsed on first paint.
const orient = page.locator('[data-levo-action="auto-orient"]');
if ((await orient.count()) === 0 || !(await orient.first().isVisible())) {
  const tray = page.locator('[data-levo-action="tool-tray"], button:has-text("Tools"), .tool-tray-toggle');
  if (await tray.count()) await tray.first().click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
}
check("the Auto-orient control is in the editor", (await orient.count()) > 0, `${await orient.count()} found`);

await orient.first().click({ timeout: 20_000 });
await page.waitForFunction(
  () => {
    const s = window.__vpApi?.()?.sceneSnapshot?.() ?? [];
    return s.length === 1 && Math.abs(s[0].rot.x) + Math.abs(s[0].rot.y) + Math.abs(s[0].rot.z) > 1e-3;
  },
  null,
  { timeout: 60_000 },
).catch(() => {});
await page.waitForTimeout(800);

const after = await page.evaluate(readScene);
const rotated = Math.abs(after[0]?.rot.x ?? 0) + Math.abs(after[0]?.rot.y ?? 0) + Math.abs(after[0]?.rot.z ?? 0);
check("pressing it rotated the tower", rotated > 1e-3, JSON.stringify(after[0]?.rot));
check("the rotation is a real number, not NaN", Number.isFinite(rotated), String(rotated));
// The whole point of laying a tower down: it must be shorter afterwards.
const height = await page.evaluate(measureHeight);
check("and laid it down — it is much shorter than it was", height < heightBefore / 2,
  `height ${height.toFixed(2)}mm, was ${heightBefore.toFixed(2)}mm`);
check("and it is still on the bed, not sunk or floating",
  Math.abs(after[0]?.lowestY ?? 9) < 0.5, `lowestY ${after[0]?.lowestY}`);

const undo = page.locator('button:has-text("Undo orientation"), button:has-text("تراجع عن التوجيه"), button:has-text("گەڕاندنەوەی ئاراستە")');
check("an undo is offered", (await undo.count()) > 0, `${await undo.count()} found`);
if (await undo.count()) {
  await undo.first().click({ timeout: 20_000 });
  await page.waitForTimeout(1_200);
  const restored = await page.evaluate(readScene);
  const back = Math.abs(restored[0]?.rot.x ?? 9) + Math.abs(restored[0]?.rot.y ?? 9) + Math.abs(restored[0]?.rot.z ?? 9);
  check("and it puts the tower back", back < 1e-6, JSON.stringify(restored[0]?.rot));
  check("back on the bed too", Math.abs(restored[0]?.lowestY ?? 9) < 0.5, `lowestY ${restored[0]?.lowestY}`);
}

writeFileSync(REPORT_PATH, `${JSON.stringify({ target, passed, failed, failures, before, after, heightBefore, height }, null, 2)}\n`);
await context.close();
await browser.close();

console.log("\n================================================================");
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
