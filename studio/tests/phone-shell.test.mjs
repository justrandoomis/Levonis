/**
 * THE PHONE SHELL (plan item C6, reference IMG_8466): what it may say, what it
 * measures, and what it must never drop.
 *
 *  - the readiness banner's decision table, run for real, including every
 *    case where a success would be easy to show by mistake;
 *  - the size readout and the orientation presets, on synthetic meshes;
 *  - the device-local theme, including the inline boot script itself;
 *  - every new string in ar, en and real Sorani (never the Arabic copied);
 *  - nothing the old bar and tray reached is unreachable now, and the AGPL
 *    source link is two taps from the main screen;
 *  - G-code is exportable only from a fresh result.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAppModule } from "./lib/load-app-module.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// --------------------------------------------------------------- readiness

test("the readiness banner never shows a success it cannot stand behind", async () => {
  const { readinessOf, toneOf } = await loadAppModule("components/mobile/readiness");
  const ok = {
    objectCount: 1,
    importing: false,
    engineReady: true,
    profileLoading: false,
    profileVerified: true,
    slicing: false,
    errored: false,
    resultState: "none",
    preflightOk: true,
  };
  assert.equal(readinessOf(ok), "ready");
  assert.equal(toneOf("ready"), "success");

  // Nothing to judge: hidden, never a premature «جاهز».
  for (const hidden of [
    { objectCount: 0 },
    { importing: true },
    { engineReady: false },
    { profileLoading: true },
    { slicing: true },
    { errored: true },
  ]) {
    assert.equal(readinessOf({ ...ok, ...hidden }), null, JSON.stringify(hidden));
  }

  // A blocker beats everything, a fresh result included.
  assert.equal(readinessOf({ ...ok, preflightOk: false }), "blocked");
  assert.equal(readinessOf({ ...ok, preflightOk: false, resultState: "fresh" }), "blocked");
  assert.equal(readinessOf({ ...ok, resultState: "rejected-over-bed" }), "blocked");
  assert.equal(toneOf("blocked"), "danger");

  // A model off the bed is blocked before the slice the engine would refuse,
  // even over a fresh result; a caller that does not know reads as on the bed.
  assert.equal(readinessOf({ ...ok, offBedCount: 1 }), "blocked");
  assert.equal(readinessOf({ ...ok, offBedCount: 2, resultState: "fresh" }), "blocked");
  assert.equal(readinessOf({ ...ok, offBedCount: 0 }), "ready");

  // An outdated result is a warning, never «ready».
  assert.equal(readinessOf({ ...ok, resultState: "stale" }), "stale");
  assert.equal(toneOf("stale"), "warning");

  // Generic fallback settings are a warning, even over a fresh result.
  assert.equal(readinessOf({ ...ok, profileVerified: false }), "fallback");
  assert.equal(readinessOf({ ...ok, profileVerified: false, resultState: "fresh" }), "fallback");
  assert.equal(toneOf("fallback"), "warning");

  assert.equal(readinessOf({ ...ok, resultState: "fresh" }), "sliced");
  assert.equal(toneOf("sliced"), "success");

  // Exhaustively: a success tone only ever comes with no blocker, a verified
  // profile and a result that is not stale.
  const bools = [true, false];
  for (const preflightOk of bools) for (const profileVerified of bools) {
    for (const resultState of ["none", "fresh", "stale", "rejected-over-bed"]) {
      const kind = readinessOf({ ...ok, preflightOk, profileVerified, resultState });
      if (kind && toneOf(kind) === "success") {
        assert.ok(preflightOk && profileVerified && (resultState === "none" || resultState === "fresh"), `${kind} with ${JSON.stringify({ preflightOk, profileVerified, resultState })}`);
      }
    }
  }
});

test("a blocked banner names the real cause: too big, or only misplaced", async () => {
  const { readinessTitleKey } = await loadAppModule("components/mobile/readiness");
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  // An 8 x 8 x 90 mm tower beside an A1 bed is not «أكبر من حجم الطابعة».
  assert.equal(readinessTitleKey("blocked", 0), "outsideBedTitle");
  assert.equal(readinessTitleKey("blocked", 1), "tooBigTitle");
  assert.equal(DICTIONARIES.ar[readinessTitleKey("blocked", 0)], "خارج حدود سطح الطباعة");
  assert.equal(DICTIONARIES.en[readinessTitleKey("blocked", 0)], "Outside the build area");
  assert.equal(DICTIONARIES.ar[readinessTitleKey("blocked", 3)], "أكبر من حجم الطابعة");
  for (const [kind, key] of [["ready", "readyToSlice"], ["sliced", "printReady"], ["stale", "stale"], ["fallback", "presetFallbackTitle"]]) {
    assert.equal(readinessTitleKey(kind, 0), key);
    assert.equal(readinessTitleKey(kind, 2), key, "the size count only matters for a block");
  }
  const banner = await read("../app/components/mobile/readiness-banner.tsx");
  assert.match(banner, /const title = t\[readinessTitleKey\(kind, oversizedCount\)\];/);
  assert.doesNotMatch(banner, /: t\.tooBigTitle;/, "no fall-through that calls every block too big");
});

test("models off the bed are found from where they are, not only how big they are", async () => {
  const { objectsOffBed, measureExtent } = await loadAppModule("model-dimensions");
  const one = { x: 1, y: 1, z: 1 };
  const zero = { x: 0, y: 0, z: 0 };
  const a1 = { width: 256, depth: 256 };
  // The reviewer's case: an 8 x 8 x 90 mm tower moved 140 mm off the centre of an A1.
  const tower = measureExtent({ id: 1, localPos: box(8, 90, 8), rot: zero, scale: one });
  assert.deepEqual([tower.minX, tower.maxX, tower.minZ, tower.maxZ], [-4, 4, -4, 4]);
  const at = (x, z, plateCentre = { x: 0, z: 0 }, extent = tower) => ({ id: 1, pos: { x, z }, extent, plateCentre });
  assert.deepEqual(objectsOffBed([at(0, 0)], a1), [], "centred: on the bed");
  assert.deepEqual(objectsOffBed([at(120, 0)], a1), [], "near the edge, still inside");
  assert.deepEqual(objectsOffBed([at(124, 0)], a1), [], "touching the edge is inside");
  assert.deepEqual(objectsOffBed([at(140, 0)], a1), [1], "wholly outside");
  assert.deepEqual(objectsOffBed([at(130, 0)], a1), [1], "partly outside is refused too");
  assert.deepEqual(objectsOffBed([at(0, -127)], a1), [1], "the depth axis counts as well");
  // Each object is judged on the bed of its own plate.
  assert.deepEqual(objectsOffBed([at(0, 296, { x: 0, z: 296 })], a1), [], "the middle of plate 2");
  assert.deepEqual(objectsOffBed([at(0, 296 + 130, { x: 0, z: 296 })], a1), [1]);
  // Unknown geometry is not judged, and a smaller bed is smaller.
  assert.deepEqual(objectsOffBed([at(500, 0, { x: 0, z: 0 }, null)], a1), []);
  assert.deepEqual(objectsOffBed([at(88, 0)], { width: 180, depth: 180 }), [1], "the A1 mini bed is 180 mm");
  // A rotation moves the reach: a quarter turn about Z lays the tower along X.
  const lying = measureExtent({ id: 2, localPos: box(8, 90, 8), rot: { x: 0, y: 0, z: Math.PI / 2 }, scale: one });
  assert.ok(Math.abs(lying.maxX - 45) < 1e-4, JSON.stringify(lying));
  assert.deepEqual(objectsOffBed([{ ...at(100, 0), extent: lying }], a1), [1], "lying down, it reaches 145 mm");
});

test("the shell drives the banner from the real preflight and the real result state", async () => {
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /import \{ runPreflight \} from "\.\/makerworld\/preflight";/);
  assert.match(client, /return runPreflight\(\{/);
  const call = client.slice(client.indexOf("const readiness = readinessOf({"), client.indexOf("});", client.indexOf("const readiness = readinessOf({")));
  for (const input of ["preflightOk: preflight.ok", "offBedCount", "resultState: currentResultState", "profileVerified: profileLoadState?.verified", "slicing: status === \"slicing\"", "errored: status === \"error\"", "importing: Boolean(importProgress)"]) {
    assert.ok(call.includes(input), `readinessOf is not given ${input}`);
  }
  assert.match(client, /\{readiness && <ReadinessBanner t=\{t\} kind=\{readiness\} detail=\{readinessDetail\} oversizedCount=\{oversizedCount\} \/>\}/);
  // The placement is measured from the scene and the bed of each plate.
  assert.match(client, /objectsOffBed\(placed, \{ width: profile\.bedWidth, depth: profile\.bedDepth \}\)/);
  assert.match(client, /api\.platePos\(adapter\.plateOfSnapshot\(entry\.snapshot, plateCount\)\)/);
  // The second line says what is wrong: size, then place, then the engine.
  assert.match(client, /\? \(oversizedCount\s*\? templateText\(t\.tooBigHelp,[\s\S]*?: offBedCount\s*\? templateText\(t\.offBedHelp,[\s\S]*?: templateText\(t\.overBedError,/);
});

// --------------------------------------------------------------- the size readout

/** A box mesh (two corner vertices are enough for an extent) of w × h × d, Y up. */
const box = (w, h, d) => new Float32Array([-w / 2, -h / 2, -d / 2, w / 2, h / 2, d / 2, w / 2, -h / 2, d / 2, -w / 2, h / 2, -d / 2]);

test("the size readout measures the model as the printer sees it", async () => {
  const { measureSnapshot, formatDimensions, createDimensionCache } = await loadAppModule("model-dimensions");
  const one = { x: 1, y: 1, z: 1 };
  const zero = { x: 0, y: 0, z: 0 };
  // 80 wide (X), 30 tall (Y), 40 deep (Z) — the reference's numbers.
  const dims = measureSnapshot({ id: 1, localPos: box(80, 30, 40), rot: zero, scale: one });
  assert.deepEqual(dims, { width: 80, depth: 40, height: 30 });
  assert.equal(formatDimensions(dims), "80 × 40 × 30 mm");
  // Scale is applied before rotation; a quarter turn about X swaps height and depth.
  const turned = measureSnapshot({ id: 1, localPos: box(80, 30, 40), rot: { x: Math.PI / 2, y: 0, z: 0 }, scale: { x: 0.5, y: 1, z: 1 } });
  assert.ok(Math.abs(turned.width - 40) < 1e-4 && Math.abs(turned.height - 40) < 1e-4 && Math.abs(turned.depth - 30) < 1e-4, JSON.stringify(turned));
  // Nothing measurable is "unknown", never zero (a zero would fit any printer).
  assert.equal(measureSnapshot({ id: 2, localPos: new Float32Array(0), rot: zero, scale: one }), null);
  assert.equal(formatDimensions({ width: 12.34, depth: 120.4, height: 7 }), "12.3 × 120 × 7 mm");
  // The cache re-measures only when the rotation, the scale or the mesh changes.
  const cache = createDimensionCache();
  const snapshot = { id: 3, localPos: box(10, 10, 10), rot: { ...zero }, scale: { ...one } };
  const first = cache.measure(snapshot);
  assert.equal(cache.measure({ ...snapshot }), first, "a move is not a re-measure");
  assert.notEqual(cache.measure({ ...snapshot, scale: { x: 2, y: 1, z: 1 } }), first);
});

// --------------------------------------------------------------- orientation presets

test("the orientation chips are read from the scene, never remembered", async () => {
  const { currentPreset, sideEuler, sameRotation, IMPORTED_EULER } = await loadAppModule("auto-orient");
  const one = { x: 1, y: 1, z: 1 };
  const tall = box(10, 40, 20);
  // A tall part lies down on the side that leaves it lowest.
  const side = sideEuler(tall, one);
  assert.ok(sameRotation(side, { x: 0, y: 0, z: Math.PI / 2 }), JSON.stringify(side));
  const objects = (rot) => [{ id: 1, rot, localPos: tall, scale: one }];
  assert.equal(currentPreset(objects(IMPORTED_EULER), new Map()), "imported");
  assert.equal(currentPreset(objects(side), new Map()), "side");
  // Same rotation, other spelling: still recognised.
  assert.equal(currentPreset(objects({ x: 2 * Math.PI, y: 0, z: 0 }), new Map()), "imported");
  // What auto-orient wrote is «تلقائي» while the object stays there…
  const auto = { x: 0.3, y: 0.1, z: 0 };
  assert.equal(currentPreset(objects(auto), new Map([[1, auto]])), "auto");
  // …and a hand rotation leaves no chip pressed rather than a stale one.
  assert.equal(currentPreset(objects({ x: 0.31, y: 0.1, z: 0 }), new Map([[1, auto]])), null);
  // Objects that disagree leave no chip pressed either.
  assert.equal(currentPreset([...objects(IMPORTED_EULER), { id: 2, rot: side, localPos: tall, scale: one }], new Map()), null);
  assert.equal(currentPreset([], new Map()), null);
});

test("the orientation presets re-seat by difference and are undoable, like auto-orient", async () => {
  const adapter = await read("../app/engine-adapter.ts");
  const fn = adapter.slice(adapter.indexOf("export function applyOrientationPreset("), adapter.indexOf("// Plane cut"));
  assert.match(fn, /const captured = adapter\.captureSceneState\(/);
  assert.match(fn, /snapshot\.pos\.y \+= before - after;/);
  assert.match(fn, /api\.restoreScene\(snapshots\);/);
  assert.match(fn, /adapter\.notifySceneEdited\(\);/);
  assert.match(fn, /undo: captured && changedCount \? \(\) => adapter\.restoreSceneState\(captured\) : null/);
});

// --------------------------------------------------------------- the theme

test("the theme is a device-local system, light or dark choice, applied before first paint", async () => {
  const theme = await loadAppModule("theme");
  assert.deepEqual([...theme.THEME_PREFERENCES], ["system", "light", "dark"]);
  assert.equal(theme.resolveTheme("system", true), "dark");
  assert.equal(theme.resolveTheme("system", false), "light");
  assert.equal(theme.resolveTheme("light", true), "light");
  assert.equal(theme.resolveTheme("dark", false), "dark");
  assert.equal(theme.isThemePreference("sepia"), false);
  // The browser chrome follows each theme's page ground.
  const css = await read("../app/globals.css");
  assert.match(css, new RegExp(`--shell: ${theme.THEME_CHROME_COLORS.dark};`, "i"));
  assert.match(css, new RegExp(`--shell: ${theme.THEME_CHROME_COLORS.light};`, "i"));

  // Run the inline boot script itself against a fake document.
  const run = ({ stored, prefersDark }) => {
    const attrs = {};
    const metas = [{ content: "", setAttribute(_n, v) { this.content = v; } }, { content: "", setAttribute(_n, v) { this.content = v; } }];
    const env = {
      localStorage: { getItem: (key) => (key === theme.THEME_STORAGE_KEY ? stored : null) },
      window: { matchMedia: () => ({ matches: prefersDark }) },
      document: {
        documentElement: { setAttribute: (n, v) => { attrs[n] = v; }, style: {} },
        querySelectorAll: () => metas,
      },
    };
    // eslint-disable-next-line no-new-func
    new Function("localStorage", "window", "document", theme.THEME_BOOT_SCRIPT)(env.localStorage, env.window, env.document);
    return { theme: attrs["data-theme"], scheme: env.document.documentElement.style.colorScheme, metas: metas.map((m) => m.content) };
  };
  assert.deepEqual(run({ stored: null, prefersDark: true }), { theme: "dark", scheme: "dark", metas: ["", ""] }, "system: the media metas already answer");
  assert.deepEqual(run({ stored: null, prefersDark: false }).theme, "light");
  assert.deepEqual(run({ stored: "light", prefersDark: true }), { theme: "light", scheme: "light", metas: [theme.THEME_CHROME_COLORS.light, theme.THEME_CHROME_COLORS.light] });
  assert.deepEqual(run({ stored: "dark", prefersDark: false }).metas, [theme.THEME_CHROME_COLORS.dark, theme.THEME_CHROME_COLORS.dark]);
  assert.equal(run({ stored: "garbage", prefersDark: false }).theme, "light", "an unknown value means system");

  const layout = await read("../app/layout.tsx");
  assert.match(layout, /<script dangerouslySetInnerHTML=\{\{ __html: THEME_BOOT_SCRIPT \}\} \/>/);
  assert.match(layout, /media: "\(prefers-color-scheme: dark\)", color: THEME_CHROME_COLORS\.dark/);
  // The theme reaches the engine's shadow roots, and the canvas stays dark.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /adapter\.setHostAttribute\("data-levo-theme", studioTheme\.resolved\)/);
  // No account column: the prefs API still stores the mode only.
  const prefs = await read("../worker/api/prefs.ts");
  assert.doesNotMatch(prefs, /theme/i);
});

// --------------------------------------------------------------- strings

const NEW_KEYS = [
  "subtitle", "import", "saveNow", "savedDraftGuest", "savedToAccount", "saveFailed", "backToSite", "leaveConfirm",
  "resetView", "expandView", "collapseView", "noModelYet", "transformTools", "toolRotate", "toolScale", "toolArrange",
  "printSettings", "material", "layerHeight", "infill", "customValue", "allSettings", "dimensions", "dimensionsPick",
  "orientation", "orientImported", "orientAuto", "orientSide", "orientPresetDone", "readyToSlice", "readyToSliceHelp",
  "tooBigTitle", "tooBigHelp", "presetFallbackTitle", "slicedSummary", "slicedEstimate", "durationHours", "durationMinutes",
  "sliceModel", "resliceModel", "exportFile", "export3mf", "exportGcode", "availableAfterSlice", "resliceFirst", "moreExport",
  "more", "moreTitle", "viewGroup", "accountGroup", "theme", "themeSystem", "themeLight", "themeDark",
  "outsideBedTitle", "offBedHelp",
];

test("every phone-shell string exists in ar, en and real Sorani", async () => {
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  for (const key of NEW_KEYS) {
    const [en, ar, ckb] = ["en", "ar", "ckb"].map((locale) => DICTIONARIES[locale][key]);
    assert.ok(en && ar && ckb, `${key} must exist in all three`);
    assert.notEqual(ckb, ar, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    if (!/^[\s{}A-Za-z0-9().,·%-]+$/.test(ckb)) assert.notEqual(ckb, en, `${key}: ckb must be translated`);
    // Placeholders survive translation.
    for (const slot of en.match(/\{\w+\}/g) ?? []) {
      assert.ok(ar.includes(slot) && ckb.includes(slot), `${key}: ${slot} is lost in a translation`);
    }
  }
  // The reference's words, in Arabic.
  const ar = DICTIONARIES.ar;
  assert.equal(ar.subtitle, "تجهيز ملفات الطباعة");
  assert.equal(ar.sliceModel, "تقطيع المجسم");
  assert.equal(ar.readyToSlice, "جاهز للتقطيع");
  assert.equal(ar.availableAfterSlice, "متاح بعد التقطيع");
  assert.equal(ar.modeSimple, "مبسط");
  assert.equal(ar.infill, "الملء");
});

// --------------------------------------------------------------- nothing dropped

test("everything the reference drops is still reachable, and the AGPL link is two taps away", async () => {
  const [client, overflow, about] = await Promise.all([
    read("../app/slicer-client.tsx"),
    read("../app/components/mobile/overflow-sheet.tsx"),
    read("../app/components/sheets/about.tsx"),
  ]);
  // Tap 1: «المزيد» is on the main screen and opens the overflow sheet.
  assert.match(client, /<button className="m-btn m-more" type="button" onClick=\{\(\) => setSheet\("more"\)\}/);
  assert.match(client, /sheet === "more" \? \(\s*<OverflowSheet/);
  // Tap 2: the source link is a plain anchor in that sheet, the same URL the
  // About sheet links.
  const url = /export const SOURCE_CODE_URL = "([^"]+)";/.exec(overflow)?.[1];
  assert.ok(url, "the source URL is declared");
  assert.ok(about.includes(`href="${url}"`), "the About sheet and the overflow sheet link the same source");
  assert.match(overflow, /<a href=\{SOURCE_CODE_URL\} target="_blank" rel="noreferrer" data-levo-more="source">/);

  // Every overflow action is wired in the shell.
  const union = /export type OverflowAction =([\s\S]*?);/.exec(overflow)?.[1] ?? "";
  const actions = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(actions.length >= 25, `expected the full overflow, saw ${actions.length}`);
  const runner = client.slice(client.indexOf("const runOverflow = useCallback("), client.indexOf("}, [canvasMode, clickControl"));
  for (const action of actions) {
    assert.ok(runner.includes(`action === "${action}"`), `the overflow action ${action} does nothing`);
  }
  // The controls the old phone bar and tray carried, by what they run.
  for (const reached of ['runTool("tool-duplicate")', 'runTool("tool-delete")', 'runTool("tool-split")', 'runTool("tool-onbed")', 'runTool("gizmo-paint")',
    "openCut()", "orientAll()", "deleteAll()", 'clickControl("plate-add")', "triggerSlice(true)", 'clickControl(canvasMode === "preview" ? "mode-prepare" : "mode-preview")',
    'shortcut("z")', 'shortcut("b")', 'clickControl("undo")', 'clickControl("redo")', "prepareForBambuHandy()", "shareCurrentGcode()",
    'clickControl("export-all")', "openPrintCenter()", 'setSheet("setup")', "openAllSettings()", 'setSheet("signout")', 'setSheet("connect")', 'setSheet("about")',
    "openProjects()", "newProject()"]) {
    assert.ok(runner.includes(reached), `${reached} is not reachable from the overflow`);
  }
  // Language, theme, sign-in and new files live in the sheet itself.
  assert.match(overflow, /LOCALES\.map/);
  assert.match(overflow, /className="theme-segments" role="radiogroup"/);
  assert.match(overflow, /href=\{SIGN_IN_HREF\}/);
  assert.match(overflow, /<FileSelectControl/);
});

// --------------------------------------------------------------- export honesty

test("G-code is exported only from a fresh result; 3MF needs no slice", async () => {
  const [client, section] = await Promise.all([read("../app/slicer-client.tsx"), read("../app/components/mobile/export-section.tsx")]);
  assert.match(section, /disabled=\{!props\.gcodeReady\}/);
  assert.match(section, /props\.gcodeReady \? props\.gcodeCaption : props\.stale \? t\.resliceFirst : t\.availableAfterSlice/);
  assert.match(client, /gcodeReady=\{printReady\}/);
  assert.match(client, /const printReady = status !== "slicing" && status !== "error" && currentResultState === "fresh";/);
  // The export path is the one that refuses a stale file on its own.
  assert.match(client, /onExportGcode=\{\(\) => \{ downloadCurrentGcode\(\); \}\}/);
  assert.match(client, /const file = currentGcodeFile\(\);\s*if \(!file\) \{/);
  // 3MF only needs something to save.
  assert.match(section, /onClick=\{props\.onExport3mf\} disabled=\{!props\.hasObjects\}/);
});

test("the gold primary and the sand selections are the owner's overrides, with a non-colour cue", async () => {
  const [css, tools, mode, model] = await Promise.all([
    read("../app/globals.css"),
    read("../app/components/mobile/transform-tool-bar.tsx"),
    read("../app/components/mobile/mode-segmented.tsx"),
    read("../app/components/mobile/model-info-card.tsx"),
  ]);
  // D-2: the sand gradient on the one primary.
  assert.match(css, /\.m-slice \{[^}]*background: var\(--gold-clay\);/);
  // D-3: solid sand on the current mode, tool and orientation, each stating
  // its state for assistive technology.
  assert.match(css, /\.m-sel\[aria-checked="true"\], \.m-sel\[aria-pressed="true"\] \{[^}]*background: var\(--gold-clay\);/);
  assert.match(mode, /className="m-sel"\s+aria-checked=\{mode === id\}/);
  assert.match(tools, /className="m-tool m-sel"\s+aria-pressed=\{active === tool\.id\}/);
  assert.match(model, /className="m-sel"\s+aria-pressed=\{props\.orientation === chip\.id\}/);
  // «استيراد» is gold outline, never a second gold fill.
  assert.match(css, /\.m-btn--outline \{ border: 1\.5px solid var\(--gold-line\); background: var\(--gold-outline-fill\); \}/);
});

// --------------------------------------------------------------- icon side, names, expanded focus

test("the icons sit at the end side of their labels, as the reference draws them", async () => {
  const [bar, slice, exp, card] = await Promise.all([
    read("../app/components/mobile/top-bar.tsx"),
    read("../app/components/mobile/primary-slice-button.tsx"),
    read("../app/components/mobile/export-section.tsx"),
    read("../app/components/mobile/viewport-card.tsx"),
  ]);
  // The label comes first in the source, so the icon lands on the end side:
  // left in Arabic and Sorani, trailing in English.
  assert.match(bar, /<span>\{t\.saveNow\}<\/span><Icon name="document" \/>/);
  assert.match(bar, /<span>\{t\.import\}<\/span><Icon name="upload" \/>/);
  assert.match(slice, /<span>\{label\}<\/span>\s*<Icon name=\{props\.printReady && !props\.slicing \? "print" : "layers"\} \/>/);
  assert.match(exp, /<span><b>\{t\.export3mf\}<\/b><\/span>\s*<Icon name="document" \/>/);
  assert.match(exp, /<b>\{t\.exportGcode\}<\/b>[\s\S]*?<\/span>\s*<Icon name="document" \/>/);
  assert.match(card, /<span>\{t\.noModelYet\}<\/span>\}\s*<Icon name="document" \/>/);
  for (const [name, source] of [["top bar", bar], ["slice", slice], ["export", exp], ["file chip", card]]) {
    assert.doesNotMatch(source, /<Icon name="(?:document|upload|layers)" \/>\s*<span>/, `${name}: an icon before its label`);
  }
  // The icons that are drawn on the start side stay there.
  assert.match(card, /<Icon name="resetView" \/><span>\{t\.resetView\}<\/span>/);
});

test("«إعادة العرض» keeps its name when its text is hidden on a narrow phone", async () => {
  const [card, css] = await Promise.all([read("../app/components/mobile/viewport-card.tsx"), read("../app/globals.css")]);
  // Under 350px the span goes; the button must still be named (WCAG 4.1.2).
  const narrow = css.slice(css.indexOf("@media (max-width: 350px) {"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.vp-tool > span \{ display: none; \}/);
  const reset = /<button[^>]*?data-levo-action="reset-view"[^>]*>/s.exec(card)?.[0] ?? "";
  assert.ok(reset, "the reset-view button is findable");
  assert.match(reset, /aria-label=\{t\.resetView\}/);
  assert.match(reset, /title=\{t\.resetView\}/);
});

test("with the viewport expanded, the page under it is inert, and Escape hands focus back", async () => {
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /<div className="studio-scroll" ref=\{scrollColumnRef\}>/);
  const effect = client.slice(client.indexOf("const column = scrollColumnRef.current;"), client.indexOf("const toggleViewportExpanded"));
  assert.ok(effect.includes("if (!column || !viewportExpanded) return;"), "only while expanded");
  // Every sibling of the card, including one that renders while expanded.
  assert.match(effect, /if \(child !== card\) \(child as HTMLElement\)\.inert = true;/);
  assert.match(effect, /new MutationObserver\(hide\)/);
  assert.match(effect, /observer\.observe\(column, \{ childList: true \}\)/);
  // And nothing is left inert after it collapses.
  assert.match(effect, /return \(\) => \{[\s\S]*?for \(const child of column\.children\) \(child as HTMLElement\)\.inert = false;/);
  // Focus never stays on a control that just went inert.
  assert.match(effect, /column\.contains\(active\) && !card\.contains\(active\)/);
  // Escape collapses and returns focus to the expand button.
  const escape = client.slice(client.indexOf("if (!viewportExpanded || sheet) return;"), client.indexOf("}, [sheet, viewportExpanded]);"));
  assert.match(escape, /setViewportExpanded\(false\);/);
  assert.match(escape, /querySelector<HTMLElement>\('\[data-levo-action="viewport-expand"\]'\)\?\.focus\(/);
});
