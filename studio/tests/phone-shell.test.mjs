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

  // THE EMPTY CURRENT PLATE (c6-r2-ha-01): one model on plate 1, «+ Plate»,
  // and plate 2 is the current one. The slice acts on plate 2 and the engine
  // refuses it («Plate 2 has no objects»), so the banner is a warning that
  // says so, never «جاهز للتقطيع». A caller that cannot place the models
  // (no count) is not judged empty.
  assert.equal(readinessOf({ ...ok, objectCount: 1, plateObjectCount: 0 }), "empty");
  assert.equal(readinessOf({ ...ok, objectCount: 3, plateObjectCount: 0, resultState: "stale" }), "empty");
  assert.equal(readinessOf({ ...ok, objectCount: 1, plateObjectCount: 0, offBedCount: 1 }), "empty", "the slice of this plate is refused whatever the others hold");
  assert.equal(toneOf("empty"), "warning");
  assert.equal(readinessOf({ ...ok, objectCount: 2, plateObjectCount: 1 }), "ready");
  assert.equal(readinessOf({ ...ok, objectCount: 1 }), "ready", "an unknown plate count is not an empty plate");
  assert.equal(readinessOf({ ...ok, objectCount: 0, plateObjectCount: 0 }), null, "no model anywhere: hidden, the card says import");

  // Exhaustively: a success tone only ever comes with no blocker, a verified
  // profile, a result that is not stale and a model on the current plate.
  const bools = [true, false];
  for (const preflightOk of bools) for (const profileVerified of bools) {
    for (const resultState of ["none", "fresh", "stale", "rejected-over-bed"]) {
      for (const plateObjectCount of [undefined, 0, 1]) {
        const kind = readinessOf({ ...ok, preflightOk, profileVerified, resultState, plateObjectCount });
        if (kind && toneOf(kind) === "success") {
          assert.ok(preflightOk && profileVerified && plateObjectCount !== 0 && (resultState === "none" || resultState === "fresh"), `${kind} with ${JSON.stringify({ preflightOk, profileVerified, resultState, plateObjectCount })}`);
        }
      }
    }
  }
});

test("an over-bed rejection stops describing the plate once the scene or the settings move on", async () => {
  // c6-r2-ha-02: the engine rejected the slice of a tower at (140, 0); «ترتيب»
  // put it back on the bed and the banner still said «خارج حدود سطح الطباعة»,
  // because the rejection was cleared only by a new slice.
  const { rejectionHolds } = await loadAppModule("hooks/use-slicing-state");
  const rejected = { sceneFingerprint: "tower@140,0", settingsRevision: 3 };
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@140,0", settingsRevision: 3 }), true, "nothing changed: still rejected");
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@-116,116", settingsRevision: 3 }), false, "arranged: the rejection is about a scene that is gone");
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@140,0", settingsRevision: 4 }), false, "a settings change (a brim, a skirt) may have been the cause");

  // After «ترتيب»: no rejection, no result, nothing off the bed: not blocked.
  const { readinessOf } = await loadAppModule("components/mobile/readiness");
  const base = { objectCount: 1, importing: false, engineReady: true, profileLoading: false, profileVerified: true, slicing: false, errored: false, preflightOk: true, plateObjectCount: 1 };
  assert.equal(readinessOf({ ...base, resultState: "rejected-over-bed", offBedCount: 1 }), "blocked", "before: rejected and off the bed");
  assert.equal(readinessOf({ ...base, resultState: "none", offBedCount: 0 }), "ready", "after arranging: the placement check decides");
  assert.equal(readinessOf({ ...base, resultState: "none", offBedCount: 1 }), "blocked", "moved, but still off the bed: still blocked");

  const hook = await read("../app/hooks/use-slicing-state.ts");
  assert.match(hook, /const rejected = overBedPlates\(\)\.get\(plate\);\s*if \(rejected && rejectionHolds\(rejected, \{/);
  assert.match(hook, /overBedPlates\(\)\.set\(payload\.plate, \{\s*sceneFingerprint: sliceStartFingerprintRef\.current \?\? currentFingerprint,\s*settingsRevision: sliceStartSettingsRevisionRef\.current,\s*\}\);/);
  assert.doesNotMatch(hook, /if \(overBedPlates\(\)\.has\(plate\)\) return "rejected-over-bed";/);
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
  for (const [kind, key] of [["ready", "readyToSlice"], ["sliced", "printReady"], ["stale", "stale"], ["fallback", "presetFallbackTitle"], ["empty", "emptyPlateTitle"]]) {
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
  for (const input of ["preflightOk: preflight.ok", "offBedCount", "plateObjectCount", "resultState: currentResultState", "profileVerified: profileLoadState?.verified", "slicing: status === \"slicing\"", "errored: status === \"error\"", "importing: Boolean(importProgress)"]) {
    assert.ok(call.includes(input), `readinessOf is not given ${input}`);
  }
  assert.match(client, /\{readiness && <ReadinessBanner t=\{t\} kind=\{readiness\} detail=\{readinessDetail\} oversizedCount=\{oversizedCount\} \/>\}/);
  // The placement is measured from the scene and the bed of each plate.
  assert.match(client, /objectsOffBed\(placed, \{ width: profile\.bedWidth, depth: profile\.bedDepth \}\)/);
  assert.match(client, /api\.platePos\(adapter\.plateOfSnapshot\(entry\.snapshot, plateCount\)\)/);
  // The empty-plate count is the selected plate's visible models, not every plate's.
  assert.match(client, /entry\.snapshot\.visible !== false && adapter\.plateOfSnapshot\(entry\.snapshot, plateCount\) === selectedPlate/);
  assert.match(client, /readiness === "empty"\s*\? templateText\(t\.emptyPlateHelp, \{ plate: selectedPlate \+ 1 \}\)/);
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
  "outsideBedTitle", "offBedHelp", "emptyPlateTitle", "emptyPlateHelp",
];

test("every phone-shell string exists in ar, en and real Sorani", async () => {
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  for (const key of NEW_KEYS) {
    const [en, ar, ckb] = ["en", "ar", "ckb"].map((locale) => DICTIONARIES[locale][key]);
    assert.ok(en && ar && ckb, `${key} must exist in all three`);
    assert.notEqual(ckb, ar, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    if (!/^[\s{}A-Za-z0-9().,·%-]+$/.test(ckb)) assert.notEqual(ckb, en, `${key}: ckb must be translated`);
    // Placeholders survive translation (in Arabic, possibly as a counted block).
    for (const slot of en.match(/\{\w+\}/g) ?? []) {
      const counted = `${slot.slice(0, -1)}, plural,`;
      assert.ok((ar.includes(slot) || ar.includes(counted)) && ckb.includes(slot), `${key}: ${slot} is lost in a translation`);
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

test("Arabic counts say «دقيقتين», «6 دقائق» and «11 دقيقة», never «6 دقيقة» or «5 طبقة»", async () => {
  // c6-r2-ha-04: the sliced banner read «49 طبقة، نحو 6 دقيقة للطباعة.»
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const { ar, en, ckb } = DICTIONARIES;
  const minutes = (m, locale = "ar") => templateText(DICTIONARIES[locale].durationMinutes, { m }, locale);
  assert.deepEqual([1, 2, 3, 10, 11].map((m) => minutes(m)), ["دقيقة واحدة", "دقيقتين", "3 دقائق", "10 دقائق", "11 دقيقة"]);
  assert.equal(minutes(100), "100 دقيقة");
  const hours = (h, m) => templateText(ar.durationHours, { h, m }, "ar");
  assert.deepEqual([1, 2, 3, 10, 11].map((h) => hours(h, 5)), ["ساعة واحدة و5 دقائق", "ساعتين و5 دقائق", "3 ساعات و5 دقائق", "10 ساعات و5 دقائق", "11 ساعة و5 دقائق"]);
  assert.equal(hours(2, 1), "ساعتين ودقيقة واحدة");
  assert.equal(hours(2, 2), "ساعتين ودقيقتين");
  assert.equal(hours(3, 0), "3 ساعات", "a whole hour drops «و0 دقيقة»");
  const layers = (n) => templateText(ar.slicedSummary, { layers: n }, "ar");
  assert.deepEqual([1, 2, 3, 10, 11].map(layers), [
    "طبقة واحدة، جاهزة للتصدير.", "طبقتان، جاهزة للتصدير.", "3 طبقات، جاهزة للتصدير.", "10 طبقات، جاهزة للتصدير.", "11 طبقة، جاهزة للتصدير.",
  ]);
  assert.equal(layers("—"), "— طبقة، جاهزة للتصدير.", "an unknown count takes the general form");
  // The reviewer's two banners, now grammatical.
  assert.equal(templateText(ar.slicedEstimate, { layers: 49, time: minutes(6) }, "ar"), "49 طبقة، نحو 6 دقائق للطباعة.");
  assert.equal(templateText(ar.slicedEstimate, { layers: 82, time: minutes(10) }, "ar"), "82 طبقة، نحو 10 دقائق للطباعة.");
  assert.equal(templateText(ar.slicedEstimate, { layers: 5, time: minutes(2) }, "ar"), "5 طبقات، نحو دقيقتين للطباعة.");
  // English and Sorani stay as they were: the unit once, after the number.
  assert.deepEqual([1, 2, 3, 11].map((m) => minutes(m, "en")), ["1 min", "2 min", "3 min", "11 min"]);
  assert.deepEqual([1, 2, 3, 11].map((m) => minutes(m, "ckb")), ["1 خولەک", "2 خولەک", "3 خولەک", "11 خولەک"]);
  assert.equal(templateText(en.slicedSummary, { layers: 3 }, "en"), "3 layers, ready to export.");
  assert.equal(templateText(ckb.durationHours, { h: 2, m: 5 }, "ckb"), "2 کاتژمێر و 5 خولەک");
  // Every call site of the counted strings passes the locale.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /templateText\(t\.slicedEstimate, \{ layers: slicedLayers \|\| "—", time: formatDuration\(estimateSeconds, t, locale\) \}, locale\)/);
  assert.match(client, /templateText\(t\.slicedSummary, \{ layers: slicedLayers \|\| "—" \}, locale\)/);
  assert.match(client, /templateText\(t\.durationHours, \{ h: hours, m: minutes % 60 \}, locale\)/);
  assert.match(client, /templateText\(t\.durationMinutes, \{ m: minutes \}, locale\)/);
});

test("«G-code» is one unbreakable token on the export tile", async () => {
  // C6-R2-FID-1: at 390 px the Sorani label wrapped as «هەناردەکردنی G-» over
  // «code», and the English one did at 320 px.
  const exp = await read("../app/components/mobile/export-section.tsx");
  const css = await read("../app/globals.css");
  const pattern = new RegExp(exp.match(/const HYPHENATED_TOKEN = \/(.+)\/;/)[1]);
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  for (const locale of ["ar", "en", "ckb"]) {
    const parts = DICTIONARIES[locale].exportGcode.split(pattern);
    assert.deepEqual(parts.filter((_, index) => index % 2 === 1), ["G-code"], `${locale}: G-code is split out whole`);
    assert.equal(parts.join(""), DICTIONARIES[locale].exportGcode, `${locale}: nothing is lost`);
    assert.deepEqual(DICTIONARIES[locale].export3mf.split(pattern).length, 1, `${locale}: 3MF has no hyphen to guard`);
  }
  assert.match(exp, /<bdi key=\{index\} dir="ltr" className="m-export__token">\{part\}<\/bdi>/);
  assert.match(css, /\.m-export__token \{ white-space: nowrap; \}/);
});

test("every self-hosted font is credited, with its copyright and licence", async () => {
  // C6-R2-REG-3: the Sorani patch (a Vazirmatn subset) and the two Cairo
  // subsets ship in public/fonts, and the notices file named none of them.
  const { readdir } = await import("node:fs/promises");
  const notices = await read("../OPEN_SOURCE_NOTICES.md");
  const license = await read("../public/fonts/cairo/LICENSE");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}${entry.name}/`);
      else if (/\.woff2?$/.test(entry.name)) files.push(`${dir}${entry.name}`.replace("../", ""));
    }
  };
  await walk("../public/fonts/");
  assert.deepEqual(files.sort(), ["public/fonts/cairo-kurdish-patch.woff2", "public/fonts/cairo/cairo-v31-arabic.woff2", "public/fonts/cairo/cairo-v31-latin.woff2"]);
  for (const file of files) assert.ok(notices.includes(`\`${file}\``), `${file} is not named in OPEN_SOURCE_NOTICES.md`);
  const fonts = notices.slice(notices.indexOf("## Fonts"), notices.indexOf("## Application dependencies"));
  assert.match(fonts, /### Cairo[\s\S]*Copyright 2009 The Cairo Project Authors[\s\S]*SIL Open Font License 1\.1 \(OFL-1\.1\)/);
  assert.match(fonts, /### Vazirmatn[\s\S]*Copyright 2015 The Vazirmatn Project Authors[\s\S]*SIL Open Font License 1\.1 \(OFL-1\.1\)/);
  assert.match(fonts, /public\/fonts\/cairo\/LICENSE/, "the notice points at the licence text");
  assert.match(license, /Copyright 2015 The Vazirmatn Project Authors/, "the licence file carries the patch copyright too");
  assert.match(license, /Copyright 2009 The Cairo Project Authors/);
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
  assert.match(overflow, /<ChoiceSegments\s+className="theme-segments"/);
  assert.match(overflow, /<ChoiceSegments\s+className="locale-segments"/);
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
  assert.match(exp, /<span><b>\{keepTokensWhole\(t\.export3mf\)\}<\/b><\/span>\s*<Icon name="document" \/>/);
  assert.match(exp, /<b>\{keepTokensWhole\(t\.exportGcode\)\}<\/b>[\s\S]*?<\/span>\s*<Icon name="document" \/>/);
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

// --------------------------------------------------------------- round 3 review

test("the empty screen's «إضافة» is the sand clay primary, and a message action is never a second gold fill", async () => {
  // c6-r3-fid-1: «إضافة» was the flat --accent, which the light theme turns
  // into #6F592B with cream ink, while the loaded screen's primary is the sand
  // gradient with near-black ink. Both are now the same recipe in both themes.
  const css = (await read("../app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} is findable`);
    return css.slice(at, css.indexOf("}", at));
  };
  const empty = rule(".empty-upload-card > .file-select-control");
  const slice = rule(".m-slice");
  for (const declaration of ["background: var(--gold-clay);", "box-shadow: var(--clay-gold);", "color: var(--gold-ink);"]) {
    assert.ok(empty.includes(declaration), `«إضافة» lacks ${declaration}`);
    assert.ok(slice.includes(declaration), `the slice button lacks ${declaration}`);
  }
  assert.doesNotMatch(empty, /var\(--accent(?:-ink)?\)/, "no flat accent on the empty primary");
  // --clay-gold carries the rim, the base, the 1px --gold-edge ring (#7A5C30 in
  // light) and the cast, so the light theme gets its 3:1 edge from it.
  assert.match(css, /--clay-gold: inset 0 1px 0 var\(--gold-rim\), inset 0 -2px 0 var\(--gold-base\), 0 0 0 1px var\(--gold-edge\), 0 6px 14px -6px var\(--clay-ambient\);/);
  assert.match(css, /:root\[data-theme="light"\] \{[^}]*--gold-edge: #7A5C30;/);
  // The undo of an arrange, an orient or a cut is a secondary action: the gold
  // outline of «استيراد», never the accent fill.
  const action = rule(".editor-message button.message-action");
  assert.ok(action.includes("border: 1.5px solid var(--gold-line);"), "the message action draws the gold outline");
  assert.ok(action.includes("background: var(--gold-outline-fill);"), "on the outline fill");
  assert.ok(action.includes("color: var(--text);"), "with the body ink");
  assert.doesNotMatch(action, /var\(--accent(?:-ink)?\)|var\(--gold-clay\)/, "never a second gold fill");
});

test("the «الخامة» row and the sheet header say the filament T1 really prints with", async () => {
  // c6-r3-ha-01: an A1 project made for PETG Basic. The engine applies its
  // project settings, T1 is PETG and the G-code says M104 S255, while the row
  // said «PLA Basic» and the header «· PLA».
  const { unzipSync, strFromU8 } = await import("fflate");
  const fixture = await readFile(new URL("./fixtures/mini-project.3mf", import.meta.url));
  const project = JSON.parse(strFromU8(unzipSync(new Uint8Array(fixture))["Metadata/project_settings.config"]));
  Object.assign(project, {
    printer_model: "Bambu Lab A1",
    printer_settings_id: "Bambu Lab A1 0.4 nozzle",
    filament_settings_id: ["Bambu PETG Basic @BBL A1"],
    filament_type: ["PETG"],
    nozzle_temperature: ["255"],
  });
  const { PROFILES, MATERIALS, materialInForce, materialPresetFor } = await loadAppModule("printer-profiles");
  const a1 = PROFILES["bbl-a1-04"];
  // The map the PLA preset load built, then the project settings on top of it,
  // as the engine writes them after the import.
  const preset = { filament_settings_id: [materialPresetFor(a1, "pla")], filament_type: ["PLA"], nozzle_temperature: [220] };
  const sliced = { ...preset, ...project };
  // Without the loader's presets the name alone decides. The client passes
  // them, and at 255 °C the row reads «PETG Basic (مخصص)» (c6fix-r1-ha-02,
  // the 230 °C test below); the type and the header are PETG either way.
  const shown = materialInForce(a1, sliced, "pla", true);
  assert.equal(shown.id, "petg", "by name, the row selects PETG Basic");
  assert.notEqual(shown.id, "pla", "never «PLA Basic» over a PETG print");
  assert.equal(MATERIALS[shown.id].label, "PETG Basic");
  assert.equal(shown.label, "PETG Basic");
  assert.equal(shown.type, "PETG", "the sheet header says PETG");
  // The preset the selector loaded still reads as itself.
  assert.deepEqual(materialInForce(a1, preset, "pla", true), { id: "pla", name: "Bambu PLA Basic @BBL A1", label: "PLA Basic", type: "PLA" });
  // A filament the printer does not list (a generic one, PLA Matte, or PETG
  // on the P1P, which ships no PETG Basic) reads as its own short name, never
  // as a listed one.
  const generic = materialInForce(a1, { ...preset, filament_settings_id: ["Generic PETG @BBL A1"], filament_type: ["PETG"] }, "pla", true);
  assert.deepEqual(generic, { id: null, name: "Generic PETG @BBL A1", label: "Generic PETG", type: "PETG" });
  assert.equal(materialInForce(a1, { filament_settings_id: ["Bambu PLA Matte @BBL A1"], filament_type: ["PLA"] }, "pla", true).label, "PLA Matte");
  assert.equal(materialInForce(PROFILES["bbl-p1p-04"], { filament_settings_id: ["Bambu PETG Basic @BBL X1C"], filament_type: ["PETG"] }, "pla", true).id, null);
  // Before the first preset load there is no filament: the selector stands.
  assert.equal(materialInForce(a1, {}, "petg", false).id, "petg");

  const [card, client] = await Promise.all([read("../app/components/mobile/print-settings-card.tsx"), read("../app/slicer-client.tsx")]);
  // The row's value is T1, and a filament it does not list is a disabled
  // «<name> (مخصص)» option in all three languages (t.customValue), as the
  // layer and infill rows already do.
  assert.match(card, /const materialShown = props\.materialInForce\.id;/);
  assert.match(card, /value=\{materialShown \?\? CUSTOM\}/);
  assert.match(card, /\{materialShown === null && <option value=\{CUSTOM\} disabled>\{customMaterialText\}<\/option>\}/);
  assert.match(card, /const customMaterialText = props\.materialInForce\.label\s*\? templateText\(t\.customValue, \{ value: props\.materialInForce\.label \}\)\s*: t\.customFilament;/);
  assert.doesNotMatch(card, /value=\{props\.material\}/, "the selector is not what the row shows");
  assert.match(client, /const presetLoaded = loadedPresetKey !== "";/);
  assert.match(client, /const t1Material = useMemo\(\s*\(\) => materialInForce\(profile, settings, material, presetLoaded, listedFilaments\),\s*\[listedFilaments, material, presetLoaded, profile, settings\],\s*\);/);
  assert.match(client, /materialInForce=\{t1Material\}/);
  assert.match(client, /\{profile\.shortName\} · \{profile\.nozzle\.toFixed\(1\)\} mm · \{t1Material\.type \|\| MATERIALS\[material\]\.type\}/);
  // Picking the material the selector already holds while T1 holds another
  // one takes T1 back: the reload is carried as a material change.
  assert.match(client, /onMaterial=\{chooseMaterial\}/);
  const choose = client.slice(client.indexOf("const chooseMaterial = useCallback("), client.indexOf("}, [material]);", client.indexOf("const chooseMaterial = useCallback(")));
  assert.match(choose, /if \(id !== material\) \{\s*setMaterial\(id\);\s*return;\s*\}/);
  assert.match(choose, /materialTakeBackRef\.current = true;\s*setMaterialTakeBack\(\(value\) => value \+ 1\);/);
  assert.match(client, /previousSelection: takeBack && loadedSelectionRef\.current\s*\? \{ \.\.\.loadedSelectionRef\.current, material: "t1-from-file" \}\s*: loadedSelectionRef\.current,/);
  assert.match(client, /\}, \[infill, material, materialTakeBack, profile, quality, requestedPresetKey, strength, support\]\);/);

  // And that carry really gives T1 back to the preset.
  const { carryUserEdits } = await loadAppModule("settings-carryover");
  const selection = { printerId: "bbl-a1-04", quality: "standard", strength: "standard", support: false, infill: "grid", material: "pla" };
  const loadedPla = { ...preset, layer_height: 0.2 };
  const carried = carryUserEdits({
    loaded: loadedPla,
    previous: sliced,
    editedKeys: new Set(),
    previousSelection: { ...selection, material: "t1-from-file" },
    nextSelection: selection,
    processKeys: [],
    filamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    previousFilamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    engineKeys: new Set(["filament_settings_id", "filament_type", "nozzle_temperature"]),
  });
  assert.equal(materialInForce(a1, carried.settings, "pla", true).id, "pla", "after the take-back the row and the G-code agree on PLA");
  assert.deepEqual(carried.settings.nozzle_temperature, [220]);
});

test("a 3MF with process settings only: the «الخامة» row says «PLA (مخصص)», never «PLA Basic», and PLA Basic takes T1 back", async () => {
  // c6-r4-ha-01: a project whose settings hold only layer 0.12, infill 40 %
  // and five walls. The engine replaces the map with those keys, the kernel
  // slices T1 with its schema defaults (no preset name, PLA, 200 °C), and the
  // row still said «PLA Basic» (220 °C) over that G-code.
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
  const fixture = unzipSync(new Uint8Array(await readFile(new URL("./fixtures/mini-project.3mf", import.meta.url))));
  const archive = zipSync({
    ...fixture,
    "Metadata/project_settings.config": strToU8(JSON.stringify({ layer_height: "0.12", sparse_infill_density: "40%", wall_loops: "5" })),
  });
  // Imported as the engine imports it: its own normalizer, then a settings
  // write that replaces the map, which the shell passes through its machine
  // lock (slicer-client setEditorSettings).
  const { normalizeProjectSettings } = await import("three-slicer/settings");
  const imported = normalizeProjectSettings(JSON.parse(strFromU8(unzipSync(archive)["Metadata/project_settings.config"])));
  assert.equal(imported.applied, 3, "only the three process keys are in the project");
  const { applyMachineLock } = await loadAppModule("machine-lock");
  const machine = { printer_model: "Bambu Lab A1", printer_settings_id: "Bambu Lab A1 0.4 nozzle", printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]], printable_height: 256, nozzle_diameter: [0.4] };
  const afterImport = applyMachineLock(imported.settings, machine);
  assert.equal(Object.prototype.hasOwnProperty.call(afterImport, "filament_settings_id"), false, "the import leaves no filament keys in the map");

  // The kernel reads a missing key as its schema default; the row says the same.
  const { KERNEL_FILAMENT_DEFAULTS, PROFILES, MATERIALS, materialInForce, materialPresetFor } = await loadAppModule("printer-profiles");
  const schema = JSON.parse(await readFile(new URL("../node_modules/three-slicer/data/config-schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.filament_settings_id.default, [KERNEL_FILAMENT_DEFAULTS.filament_settings_id]);
  assert.deepEqual(schema.filament_type.default, [KERNEL_FILAMENT_DEFAULTS.filament_type]);
  const a1 = PROFILES["bbl-a1-04"];
  const shown = materialInForce(a1, afterImport, "pla", true);
  assert.deepEqual(shown, { id: null, name: "", label: "PLA", type: "PLA" });
  assert.notEqual(shown.id, "pla", "never «PLA Basic» over an unnamed filament");
  // An explicitly empty preset name reads the same way.
  assert.deepEqual(materialInForce(a1, { filament_settings_id: [""], filament_type: ["PETG"] }, "pla", true), { id: null, name: "", label: "PETG", type: "PETG" });
  // Only before the first preset load does a map without filament keys read as the selector.
  assert.equal(materialInForce(a1, afterImport, "pla", false).id, "pla");
  assert.equal(materialInForce(a1, { filament_settings_id: [""] }, "pla", false).id, null, "an empty name is never the selector");
  // What the row prints, in all three languages: «PLA (مخصص)», "PLA (custom)», «PLA (تایبەت)».
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  assert.equal(templateText(DICTIONARIES.ar.customValue, { value: shown.label }), "PLA (مخصص)");
  assert.equal(templateText(DICTIONARIES.en.customValue, { value: shown.label }), "PLA (custom)");
  assert.equal(templateText(DICTIONARIES.ckb.customValue, { value: shown.label }), "PLA (تایبەت)");
  // A filament with no type either is named, never blank.
  assert.equal(materialInForce(a1, { filament_settings_id: [""], filament_type: [""] }, "pla", true).label, "");
  for (const locale of ["ar", "en", "ckb"]) assert.ok(DICTIONARIES[locale].customFilament, `customFilament in ${locale}`);
  assert.notEqual(DICTIONARIES.ckb.customFilament, DICTIONARIES.ar.customFilament);

  // Picking PLA Basic (the selector already holds it) takes T1 back: the
  // reload is carried as a material change, as in the client.
  const { carryUserEdits, recordEngineWrites } = await loadAppModule("settings-carryover");
  const loadedPla = { ...machine, filament_settings_id: [materialPresetFor(a1, "pla")], filament_type: ["PLA"], nozzle_temperature: [220], layer_height: 0.2, sparse_infill_density: 15, wall_loops: 2 };
  const engineKeys = recordEngineWrites({ before: loadedPla, after: afterImport, preset: loadedPla, engine: new Set(), byPerson: false });
  const selection = { printerId: "bbl-a1-04", quality: "standard", strength: "standard", support: false, infill: "grid", material: "pla" };
  const carried = carryUserEdits({
    loaded: loadedPla,
    previous: afterImport,
    editedKeys: new Set(),
    previousSelection: { ...selection, material: "t1-from-file" },
    nextSelection: selection,
    processKeys: [],
    filamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    previousFilamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    engineKeys,
  });
  const back = materialInForce(a1, carried.settings, "pla", true);
  assert.equal(back.id, "pla", "after the take-back the row and the G-code agree on PLA Basic");
  assert.equal(MATERIALS[back.id].label, "PLA Basic");
  assert.deepEqual(carried.settings.nozzle_temperature, [220]);
  assert.equal(Number(carried.settings.layer_height), 0.12, "the file's own layer height stays");
});

test("a 3MF that names PETG Basic at 230 °C: the «الخامة» row says «PETG Basic (مخصص)», and PETG Basic takes T1 back", async () => {
  // c6fix-r1-ha-02: the row matched a listed material by
  // filament_settings_id[0] alone. A project naming «Bambu PETG Basic @BBL
  // A1» with nozzle_temperature 230 read «PETG Basic» over a G-code at
  // M104 S230 (the preset prints at 245), and with PETG Basic already shown a
  // native select fires no change, so nothing could take T1 back.
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
  const fixture = unzipSync(new Uint8Array(await readFile(new URL("./fixtures/mini-project.3mf", import.meta.url))));
  const projectFor = (over) => zipSync({
    ...fixture,
    "Metadata/project_settings.config": strToU8(JSON.stringify({
      printer_model: "Bambu Lab A1",
      printer_settings_id: "Bambu Lab A1 0.4 nozzle",
      layer_height: "0.2",
      filament_settings_id: ["Bambu PETG Basic @BBL A1"],
      filament_type: ["PETG"],
      nozzle_temperature: ["230"],
      hot_plate_temp: ["70"],
      ...over,
    })),
  });
  // Imported as the engine imports it (its own normalizer, then a settings
  // write the shell passes through its machine lock), as in the test above.
  const { normalizeProjectSettings } = await import("three-slicer/settings");
  const { applyMachineLock } = await loadAppModule("machine-lock");
  const machine = { printer_model: "Bambu Lab A1", printer_settings_id: "Bambu Lab A1 0.4 nozzle", printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]], printable_height: 256, nozzle_diameter: [0.4] };
  const importProject = (over = {}) => {
    const archive = projectFor(over);
    const imported = normalizeProjectSettings(JSON.parse(strFromU8(unzipSync(archive)["Metadata/project_settings.config"])));
    return applyMachineLock(imported.settings, machine);
  };

  // The presets are the ones the profile loader reads from the engine, the
  // same object the client hands to the row (listedFilaments).
  const { KERNEL_TEMPERATURE_DEFAULTS, PROFILES, MATERIALS, materialInForce } = await loadAppModule("printer-profiles");
  const { loadPrinterProfile } = await loadAppModule("profile-loader");
  const a1 = PROFILES["bbl-a1-04"];
  const loadedPla = await loadPrinterProfile(a1, "standard", "standard", false, "balanced", "pla");
  const presets = loadedPla.listedFilaments;
  assert.deepEqual(Object.keys(presets).sort(), ["petg", "pla"], "the loader holds both listed presets of the A1");
  assert.deepEqual([presets.petg.nozzle_temperature[0], presets.petg.hot_plate_temp[0]], [245, 70], "PETG Basic on the A1 prints at 245 / 70");
  assert.deepEqual([presets.pla.nozzle_temperature[0], presets.pla.hot_plate_temp[0]], [220, 65], "PLA Basic on the A1 prints at 220 / 65");

  // The kernel prints its schema default for a temperature the map does not hold.
  const schema = JSON.parse(await readFile(new URL("../node_modules/three-slicer/data/config-schema.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(KERNEL_TEMPERATURE_DEFAULTS)) assert.deepEqual(schema[key].default, [value], `${key} default`);

  // 230 °C under the PETG Basic name: custom, with the listed name.
  const hot = importProject();
  const shown = materialInForce(a1, hot, "pla", true, presets);
  assert.deepEqual(shown, { id: null, name: "Bambu PETG Basic @BBL A1", label: "PETG Basic", type: "PETG" });
  assert.notEqual(shown.id, "petg", "never «PETG Basic» over a G-code at M104 S230");
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  assert.equal(templateText(DICTIONARIES.ar.customValue, { value: shown.label }), "PETG Basic (مخصص)");
  assert.equal(templateText(DICTIONARIES.en.customValue, { value: shown.label }), "PETG Basic (custom)");
  assert.equal(templateText(DICTIONARIES.ckb.customValue, { value: shown.label }), "PETG Basic (تایبەت)");
  // The same with the selector already on PETG: the row still says custom,
  // so PETG Basic is an option the select can change to.
  assert.equal(materialInForce(a1, hot, "petg", true, presets).id, null);

  // At the preset temperatures the name is the preset.
  assert.equal(materialInForce(a1, importProject({ nozzle_temperature: ["245"] }), "pla", true, presets).id, "petg");
  // A plate temperature the map does not hold is the kernel default (45), not the preset 70.
  const noPlate = importProject({ nozzle_temperature: ["245"], hot_plate_temp: undefined });
  assert.equal(Object.prototype.hasOwnProperty.call(noPlate, "hot_plate_temp"), false);
  assert.equal(materialInForce(a1, noPlate, "pla", true, presets).id, null, "M140 S45 is not PETG Basic");
  // Another plate temperature, and the 255 °C project of c6-r3-ha-01.
  assert.equal(materialInForce(a1, importProject({ nozzle_temperature: ["245"], hot_plate_temp: ["80"] }), "pla", true, presets).id, null);
  assert.equal(materialInForce(a1, importProject({ nozzle_temperature: ["255"] }), "pla", true, presets).label, "PETG Basic");
  // With no preset to compare with (the engine shipped none) the name decides, as before.
  assert.equal(materialInForce(a1, hot, "pla", true, {}).id, "petg");

  // PETG Basic takes T1 back. From the PLA selector it is a material change;
  // with the selector already on PETG it is the take-back reload. Either way
  // the PETG preset's filament keys replace the file's.
  const { carryUserEdits, recordEngineWrites } = await loadAppModule("settings-carryover");
  const loadedPetg = await loadPrinterProfile(a1, "standard", "standard", false, "balanced", "petg");
  const selection = { printerId: "bbl-a1-04", quality: "standard", strength: "standard", support: false, infill: "balanced" };
  for (const [selector, previousMaterial] of [["pla", "pla"], ["petg", "t1-from-file"]]) {
    const before = selector === "pla" ? loadedPla : loadedPetg;
    const engineKeys = recordEngineWrites({ before: before.settings, after: hot, preset: before.settings, engine: new Set(), byPerson: false });
    const carried = carryUserEdits({
      loaded: loadedPetg.settings,
      previous: hot,
      editedKeys: new Set(),
      previousSelection: { ...selection, material: previousMaterial },
      nextSelection: { ...selection, material: "petg" },
      processKeys: loadedPetg.processKeys,
      filamentKeys: loadedPetg.filamentKeys,
      previousFilamentKeys: before.filamentKeys,
      engineKeys,
    });
    const back = materialInForce(a1, carried.settings, "petg", true, loadedPetg.listedFilaments);
    assert.equal(back.id, "petg", `after picking PETG Basic (selector ${selector}) the row and the G-code agree`);
    assert.equal(MATERIALS[back.id].label, "PETG Basic");
    assert.deepEqual(carried.settings.nozzle_temperature, [245]);
  }
  // A plain preset load reads as itself, PLA and PETG.
  assert.equal(materialInForce(a1, loadedPla.settings, "pla", true, presets).id, "pla");
  assert.equal(materialInForce(a1, loadedPetg.settings, "petg", true, presets).id, "petg");

  // The loader hands the presets over and the client passes them to the row.
  const [loader, client] = await Promise.all([read("../app/profile-loader.ts"), read("../app/slicer-client.tsx")]);
  assert.match(loader, /listedFilaments,\n/);
  assert.match(client, /setListedFilaments\(loaded\.listedFilaments\);\s*setLoadedPresetKey\(requestedPresetKey\);/);
  assert.match(client, /setListedFilaments\(\{\}\);\s*setLoadedPresetKey\(requestedPresetKey\);/);
});

// --------------------------------------------------------------- keys

test("an arrow key a shell group handles stops at the group, and nothing behind an open sheet hears a key", async () => {
  // c6-r4-ha-02: the engine nudges the selected model 10 mm on any arrow
  // that reaches window. ArrowLeft on «مبسط» changed the mode AND moved the
  // model; ArrowLeft on «العربية» or «داكن» moved the model behind the
  // modal sheet.
  const { consumeRovingKey, rovingTarget } = await loadAppModule("components/mobile/roving");
  const previous = globalThis.getComputedStyle;
  let direction = "rtl";
  globalThis.getComputedStyle = () => ({ direction });
  try {
    const press = (key, extra = {}) => {
      const event = { key, currentTarget: {}, altKey: false, ctrlKey: false, metaKey: false, ...extra, prevented: false, stopped: false };
      event.preventDefault = () => { event.prevented = true; };
      event.stopPropagation = () => { event.stopped = true; };
      return event;
    };
    // Right-to-left: left is next.
    let event = press("ArrowLeft");
    assert.equal(consumeRovingKey(event, 0, 3), 1);
    assert.ok(event.prevented && event.stopped, "a handled arrow never bubbles on to window");
    assert.equal(rovingTarget(press("ArrowRight"), 1, 3), 0);
    assert.equal(rovingTarget(press("ArrowDown"), 1, 3), 2);
    assert.equal(rovingTarget(press("ArrowUp"), 1, 3), 0);
    assert.equal(rovingTarget(press("Home"), 2, 3), 0);
    assert.equal(rovingTarget(press("End"), 0, 3), 2);
    // At an end it stays, and the key is still the group's.
    event = press("ArrowLeft");
    assert.equal(consumeRovingKey(event, 2, 3), 2);
    assert.ok(event.stopped);
    // Left-to-right: right is next.
    direction = "ltr";
    assert.equal(rovingTarget(press("ArrowRight"), 0, 3), 1);
    // A key the group does not use is left alone, for the page and the engine.
    for (const other of [press("Delete"), press("m"), press("Tab"), press("ArrowLeft", { ctrlKey: true })]) {
      assert.equal(consumeRovingKey(other, 0, 3), -1);
      assert.ok(!other.prevented && !other.stopped, other.key);
    }
  } finally {
    globalThis.getComputedStyle = previous;
  }

  const [mode, model, choices, overflow, setup, client, tools, chooser, connect] = await Promise.all([
    read("../app/components/mobile/mode-segmented.tsx"),
    read("../app/components/mobile/model-info-card.tsx"),
    read("../app/components/mobile/choice-segments.tsx"),
    read("../app/components/mobile/overflow-sheet.tsx"),
    read("../app/components/sheets/setup.tsx"),
    read("../app/slicer-client.tsx"),
    read("../app/components/mobile/transform-tool-bar.tsx"),
    read("../app/components/sheets/printer-choice.tsx"),
    read("../app/components/sheets/connect.tsx"),
  ]);
  // Every shell group consumes its keys: the mode, the orientation chips,
  // the language and the appearance.
  assert.match(mode, /const next = consumeRovingKey\(event, index, STUDIO_MODES\.length\);/);
  assert.match(model, /const next = consumeRovingKey\(event, index, 3\);/);
  assert.match(model, /onKeyDown=\{\(event\) => onKeyDown\(event, index\)\}/);
  assert.match(choices, /const next = consumeRovingKey\(event, index, props\.choices\.length\);/);
  assert.match(choices, /tabIndex=\{checked \? 0 : -1\}/);
  assert.match(overflow, /<ChoiceSegments\s+className="locale-segments"[\s\S]*?followFocus=\{false\}/);
  assert.match(overflow, /<ChoiceSegments\s+className="theme-segments"[\s\S]*?followFocus\s/);
  assert.match(setup, /<ChoiceSegments\s+className="theme-segments"/);
  // c6fix-r2-ha-02: the transform toolbar too. ArrowLeft on «تحريك» kept the
  // focus there and moved the selected model 10 mm. The arrows, Home and End
  // now walk the four tiles, and the one tab stop moves with the focus.
  assert.match(tools, /role="toolbar"/);
  assert.match(tools, /const next = consumeRovingKey\(event, index, TILE_COUNT\);\s*if \(next < 0\) return;\s*setStop\(next\);\s*refs\.current\[next\]\?\.focus\(\);/);
  assert.match(tools, /const TILE_COUNT = 4;/);
  assert.match(tools, /tabIndex=\{index === stop \? 0 : -1\}[\s\S]*?onFocus=\{\(\) => setStop\(index\)\}[\s\S]*?onKeyDown=\{\(event\) => onKeyDown\(event, index\)\}/);
  assert.match(tools, /tabIndex=\{stop === ARRANGE \? 0 : -1\}[\s\S]*?onFocus=\{\(\) => setStop\(ARRANGE\)\}[\s\S]*?onKeyDown=\{\(event\) => onKeyDown\(event, ARRANGE\)\}/);
  // c6fix-r2-ha-04: the sheets' radiogroups and the connection tabs. Every
  // option was a tab stop and the arrows did nothing.
  assert.match(setup, /const next = consumeRovingKey\(event, index, props\.tiles\.length\);\s*if \(next < 0\) return;\s*props\.onChoose\(props\.tiles\[next\]\.id\);/);
  assert.match(setup, /tabIndex=\{index === Math\.max\(checkedIndex, 0\) \? 0 : -1\}/);
  assert.match(setup, /<RadioTiles\s+className="segmented-control mode-control"\s+label=\{t\.modeTitle\}/);
  assert.match(chooser, /const next = consumeRovingKey\(event, index, PROFILE_IDS\.length\);\s*if \(next < 0\) return;\s*props\.onDraft\(PROFILE_IDS\[next\]\);/);
  assert.match(chooser, /tabIndex=\{index === Math\.max\(draftIndex, 0\) \? 0 : -1\}/);
  assert.match(chooser, /onKeyDown=\{\(event\) => onKeyDown\(event, index\)\}/);
  assert.match(connect, /const next = consumeRovingKey\(event, index, CONNECTION_MODES\.length\);\s*if \(next < 0\) return;\s*setMode\(CONNECTION_MODES\[next\]\);/);
  assert.match(connect, /role="tab"\s+id=\{tabId\(tab\)\}\s+aria-selected=\{mode === tab\}\s+aria-controls=\{panelId\}\s+tabIndex=\{mode === tab \? 0 : -1\}/);
  assert.match(connect, /const panel = \{ role: "tabpanel", id: panelId, "aria-labelledby": tabId\(mode\) \} as const;/);
  assert.equal(connect.split("{...panel}>").length - 1, 3, "each of the three panels is the tabpanel");
  // While a sheet is open, a key from outside the engine mount stops at the
  // document, before window, where the engine listens.
  const effect = client.slice(client.indexOf("NOTHING BEHIND THE SHEET HEARS A KEY"), client.indexOf("}, [sheet]);", client.indexOf("NOTHING BEHIND THE SHEET HEARS A KEY")));
  assert.ok(effect.length > 200, "the sheet key effect is findable");
  assert.match(effect, /if \(!sheet\) return;/);
  assert.match(effect, /if \(!\(mount && event\.target instanceof Node && mount\.contains\(event\.target\)\)\) event\.stopPropagation\(\);/);
  assert.match(effect, /document\.addEventListener\("keydown", onKey\);/);
  // And the engine listens on window, so a stop at the document is enough.
  const engine = await readFile(new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url), "utf8");
  assert.match(engine, /window\.addEventListener\("keydown", /);
});

test("the chosen language and appearance are marked without colour, with a 3:1 change", async () => {
  // c6-r4-ha-03: the chosen option differed by about 1.05:1 in fill and
  // 2.3 to 2.6:1 in text, with no other cue.
  const [css, choices] = await Promise.all([read("../app/globals.css"), read("../app/components/mobile/choice-segments.tsx")]);
  const rule = /\.locale-segments button\[aria-checked="true"\], \.theme-segments button\[aria-checked="true"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule, "the chosen option has its own rule");
  assert.match(rule, /background: var\(--gold-clay\);/);
  assert.match(rule, /box-shadow: var\(--clay-gold\);/);
  assert.match(rule, /color: var\(--gold-ink\);/);
  assert.doesNotMatch(css, /\.locale-segments button\.active, \.theme-segments button\.active \{ border-color: var\(--line\); background: var\(--surface\);/);
  // The non-colour cue: a check mark before the label, and aria-checked.
  assert.match(choices, /aria-checked=\{checked\}/);
  assert.match(choices, /\{checked && <Icon name="check" \/>\}\s*<span>\{choice\.label\}<\/span>/);

  // The 3:1: sand against the unchosen panel in dark; in light the gold edge
  // of --clay-gold against the cream panel.
  const token = (scope, name) => new RegExp(`${scope}[\\s\\S]*?--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const gold2 = token(":root", "gold-2");
  const darkPanel = token(":root", "panel");
  assert.ok(gold2 && darkPanel, "the dark tokens are readable");
  assert.ok(ratio(gold2, darkPanel) >= 3, `dark: sand on the panel is ${ratio(gold2, darkPanel).toFixed(2)}:1`);
  const light = css.slice(css.indexOf('[data-theme="light"]'));
  const lightEdge = /--gold-edge:\s*(#[0-9a-fA-F]{6})/.exec(light)?.[1];
  const lightPanel = /--panel:\s*(#[0-9a-fA-F]{6})/.exec(light)?.[1];
  assert.ok(lightEdge && lightPanel, "the light tokens are readable");
  assert.ok(ratio(lightEdge, lightPanel) >= 3, `light: the gold edge on the panel is ${ratio(lightEdge, lightPanel).toFixed(2)}:1`);
  assert.match(css, /--clay-gold: [^;]*0 0 0 1px var\(--gold-edge\)/);
});

// --------------------------------------------------------------- engine sentences

const ENGINE_SENTENCES = [
  ["notice", "Imported this project's 8 settings and 1 plates.", "engineImportedProject", "Imported this project's "],
  ["notice", "Imported this project's 3 settings and 4 filaments and 2 plates. Not supported by this slicer, so left out: seam painting, 3 object(s) on plates past this viewer's limit.", "engineImportedProject", " Not supported by this slicer, so left out: "],
  ["notice", "Imported this project's geometry. Not supported by this slicer, so left out: variable layer height.", "engineImportedProject", "variable layer height"],
  ["error", "Select an object to duplicate first", "engineSelectToDuplicate"],
  ["error", "Select an object to copy first", "engineSelectToCopy"],
  ["error", "Select an object to delete first", "engineSelectToDelete"],
  ["error", "Select an object to split first", "engineSelectToSplit"],
  ["error", "Nothing selected — click an object first", "engineNothingSelected"],
  ["error", "Nothing to export — load a model first", "engineNothingToExport"],
  ["error", "Upload an STL first", "engineLoadModelFirst"],
  ["notice", "Object copied (paste with Ctrl+V)", "engineCopied"],
  ["notice", "Deleted all 3 object(s)", "engineDeletedAll", "Deleted all "],
  ["notice", "Split into 4 objects", "engineSplitDone", "Split into "],
  ["error", "No separate parts to split — this is a single connected mesh", "engineSplitSingle"],
  ["error", "Split failed: out of memory", "engineSplitFailed", "Split failed: "],
  ["notice", "Memory pressure — finished in economy mode (no preview, G-code can still be downloaded)", "engineEconomy"],
  ["notice", "Memory pressure — some plates finished in economy mode (no preview, G-code is fine)", "engineEconomySomePlates"],
  ["notice", "Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)", "engineClassicWalls"],
  ["notice", "Support generation failed (no overhangs) — the slice contains the model only", "engineSupportFailed", ") — the slice contains the model only"],
  ["notice", "Slice canceled", "engineSliceCanceled"],
  ["error", "Plate 2 has no objects", "enginePlateEmpty", " has no objects"],
  ["error", "All plates failed to slice (economy mode included) — try the simplified retry", "engineAllPlatesFailed"],
  ["error", "Plate 1, 3 failed — the 2 finished result(s) are kept (inspect/export from the tabs)", "enginePlatesFailed", " finished result(s) are kept (inspect/export from the tabs)"],
  ["error", "Slice failed: kernel abort", "engineSliceFailed", "Slice failed: "],
  ["error", "Slice failed (economy mode failed too): kernel abort", "engineSliceFailed", "Slice failed (economy mode failed too): "],
  ["error", "Worker terminated (likely out of memory): worker error", "engineWorkerStopped", "Worker terminated (likely out of memory): "],
  ["notice", "Saved 2 object(s) as a 3mf project with 120 painted facets.", "engineSaved3mf", "as a 3mf project"],
  ["notice", "Exported 1 selected object(s) as STL (2400 triangles).", "engineExportedStl", "as STL ("],
  ["error", "Export failed: quota", "engineExportFailed", "Export failed: "],
  ["notice", "Exported 3 plate(s) — skipped 1 that extend beyond the bed", "engineExportedPlates", " that extend beyond the bed"],
  ["error", "Every sliced plate extends beyond the bed — nothing exported", "engineExportAllOverBed"],
  ["error", "No slice results to export — slice first", "engineNothingSliced"],
  ["error", "Failed to load bracket.stl: bad header", "engineFileFailed", "Failed to load "],
  ["error", "Supported formats: STL/OBJ/3MF/AMF/PLY + preset files", "importFailed", "Supported formats: STL/OBJ/3MF/AMF/PLY"],
  ["error", "No printable moves found in the G-code", "engineGcodeUnreadable"],
  ["notice", "Only T1 was painted. T1 is the default extruder every unpainted facet already uses, so the slice is unchanged — paint T2 or higher to get a second material.", "enginePaintOnlyT1"],
  ["notice", "Support is on and T2 is painted. One facet carries one mark, and a support blocker is the same mark as T2 — the painted areas were sliced as T2, not as blocked support.", "enginePaintSupportT2"],
  ["notice", "The model changed, so the painted regions were reset — the paint is tied to the facets it was brushed onto.", "enginePaintReset"],
  ["notice", "This project paints both material and support. One facet holds one paint state, so the material painting was imported and the support painting was dropped.", "enginePaintBothImported"],
  ["notice", "Saved \"My A1\" as an OrcaSlicer machine preset", "enginePresetSaved", "as an OrcaSlicer machine preset"],
  ["error", "Could not save the printer preset: denied", "enginePresetSaveFailed", "Could not save the printer preset: "],
  ["error", "No presets found in that file", "enginePresetFileUnreadable"],
  ["notice", "Loaded Bambu PLA Basic @BBL A1 — 1 warning(s): unknown key", "enginePresetsLoaded", " warning(s): "],
];

test("the engine's sentences reach the message row in the person's language, never as raw English in Arabic or Sorani", async () => {
  // c6-r4-ha-04: «Imported this project's 8 settings and 1 plates.» and
  // «Select an object to duplicate first» in the Arabic and Sorani row.
  const { engineMessageKey, localizeEngineMessage } = await loadAppModule("engine-messages");
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const latinSentence = /[A-Za-z]{3,}(?:\s+[A-Za-z]{2,}){2,}/;
  // A preset or file name is carried as it is (it is a name, not a sentence).
  const names = ["Bambu PLA Basic @BBL A1", "My A1", "bracket.stl"];
  for (const [kind, raw, key] of ENGINE_SENTENCES) {
    assert.equal(engineMessageKey(raw), key, raw);
    for (const locale of ["ar", "ckb"]) {
      const text = names.reduce((out, name) => out.split(name).join("·"), localizeEngineMessage(raw, kind, DICTIONARIES[locale], locale));
      assert.ok(text, `${locale}: ${raw}`);
      assert.doesNotMatch(text, latinSentence, `${locale} shows English for «${raw}»: ${text}`);
    }
    assert.ok(localizeEngineMessage(raw, kind, DICTIONARIES.en, "en"), `en: ${raw}`);
  }
  // The numbers and names are carried over, in Arabic with its counted forms.
  const ar = (raw, kind = "notice") => localizeEngineMessage(raw, kind, DICTIONARIES.ar, "ar");
  assert.equal(ar("Imported this project's 8 settings and 1 plates."), "استُورد من هذا المشروع: 8 إعدادات، توزيع 1 Plate.");
  assert.equal(ar("Imported this project's 2 settings."), "استُورد من هذا المشروع: إعدادان.");
  assert.match(ar("Imported this project's 3 settings and 4 filaments and 2 plates. Not supported by this slicer, so left out: seam painting, 3 object(s) on plates past this viewer's limit."), /وتُرك ما لا يدعمه هذا المحرر: رسم خط الدرز، 3 مجسمات على Plate/);
  assert.equal(ar("Select an object to duplicate first", "error"), DICTIONARIES.ar.engineSelectToDuplicate);
  assert.equal(ar("Plate 2 has no objects", "error"), "Plate 2 لا تحوي أي مجسم.");
  assert.equal(ar("Failed to load bracket.stl: bad header", "error"), "تعذّر فتح bracket.stl.");
  assert.equal(localizeEngineMessage("Split into 4 objects", "notice", DICTIONARIES.ckb, "ckb"), "بۆ 4 تەن دابەش کرا.");
  assert.equal(localizeEngineMessage("Imported this project's 8 settings and 1 plates.", "notice", DICTIONARIES.en, "en"), "Imported from this project: 8 settings, the layout of 1 plate.");
  // An unknown sentence: a generic line in Arabic and Sorani, the engine's
  // own English in English; an empty one is the engine clearing its message.
  for (const locale of ["ar", "ckb"]) {
    assert.equal(localizeEngineMessage("Kernel said something new", "error", DICTIONARIES[locale], locale), DICTIONARIES[locale].engineErrorGeneric);
    assert.equal(localizeEngineMessage("Kernel said something new", "notice", DICTIONARIES[locale], locale), DICTIONARIES[locale].engineNoticeGeneric);
  }
  assert.equal(localizeEngineMessage("Kernel said something new", "notice", DICTIONARIES.en, "en"), "Kernel said something new");
  assert.equal(localizeEngineMessage("", "error", DICTIONARIES.ar, "ar"), "");
  void templateText;

  // Every literal the shipped engine passes to its error and notice setters
  // has a rule: no sentence falls through to the generic line by oversight.
  const engine = await readFile(new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url), "utf8");
  for (const [, raw, , fragment] of ENGINE_SENTENCES) {
    assert.ok(engine.includes(fragment ?? raw), `«${fragment ?? raw}» is no longer an engine sentence`);
  }

  // The client sends both kinds through the map, and its own two load failures are dictionary lines.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /setNotice\(localizeEngineMessage\(event\.value, "notice", textRef\.current, localeRef\.current\)\);/);
  assert.match(client, /const message = localizeEngineMessage\(event\.value, "error", textRef\.current, localeRef\.current\);\s*setError\(message\);/);
  assert.match(client, /setDowngradeOfferFor\(adapter\.isControlAvailable\("downgrade-retry"\) \? message : null\);/);
  assert.doesNotMatch(client, /setNotice\(event\.value\)|setError\(event\.value\)/);
  assert.match(client, /setError\(textRef\.current\.engineBootFailed\);/);
  assert.match(client, /setError\(textRef\.current\.profileLoadFailed\);/);

  // Duplicate, split and delete wait for a selection instead of answering
  // «Select an object … first».
  const overflow = await read("../app/components/mobile/overflow-sheet.tsx");
  for (const action of ["duplicate", "split", "delete"]) {
    assert.match(overflow, new RegExp(`tile\\("${action}", "[a-z]+", t\\.[a-z]+, \\{ disabled: none \\|\\| !props\\.hasSelection`), action);
  }
  assert.match(client, /hasSelection=\{engineHasSelection\(\)\}/);
});

const ENGINE_KEYS = [
  "customFilament", "engineNoticeGeneric", "engineErrorGeneric", "engineImportedProject", "engineImportedSettings", "engineImportedFilaments",
  "engineImportedPlates", "engineImportedGeometry", "engineImportLeftOut", "engineSkipSeam", "engineSkipFuzzy", "engineSkipVariableLayer",
  "engineSkipLayerGcode", "engineSkipObjectOverrides", "engineSkipPlatesPastLimit", "engineSkipOther", "engineSelectToDuplicate",
  "engineSelectToCopy", "engineSelectToDelete", "engineSelectToSplit", "engineNothingSelected", "engineNothingToExport", "engineLoadModelFirst",
  "engineCopied", "engineDeletedAll", "engineSplitDone", "engineSplitSingle", "engineSplitFailed", "engineEconomy", "engineEconomySomePlates",
  "engineClassicWalls", "engineSupportFailed", "engineSliceCanceled", "enginePlateEmpty", "engineAllPlatesFailed", "enginePlatesFailed",
  "engineSliceFailed", "engineWorkerStopped", "engineSaved3mf", "engineExportedStl", "engineExportFailed", "engineExportedPlates",
  "engineExportSkippedPlates", "engineExportAllOverBed", "engineNothingSliced", "engineFileFailed", "engineGcodeUnreadable",
  "enginePaintOnlyT1", "enginePaintSupportT2", "enginePaintReset", "enginePaintBothImported", "enginePresetSaved", "enginePresetsLoaded",
  "enginePresetSaveFailed", "enginePresetFileUnreadable", "engineBootFailed", "profileLoadFailed",
];

test("every engine line and the custom filament exist in ar, en and real Sorani", async () => {
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  const { ENGINE_MESSAGE_RULES } = await loadAppModule("engine-messages");
  for (const rule of ENGINE_MESSAGE_RULES) assert.ok(ENGINE_KEYS.includes(rule.key) || rule.key === "importFailed", `${rule.key} is checked below`);
  for (const key of ENGINE_KEYS) {
    const [en, ar, ckb] = ["en", "ar", "ckb"].map((locale) => DICTIONARIES[locale][key]);
    assert.ok(en && ar && ckb, `${key} must exist in all three`);
    assert.notEqual(ckb, ar, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${key}: ckb must be translated`);
    assert.notEqual(ar, en, `${key}: ar must be translated`);
    for (const slot of en.match(/\{\w+\}/g) ?? []) {
      const counted = `${slot.slice(0, -1)}, plural,`;
      assert.ok((ar.includes(slot) || ar.includes(counted)) && ckb.includes(slot), `${key}: ${slot} is lost in a translation`);
    }
  }
});

test("the sheets are modal: the page behind is inert, Tab wraps, and focus returns to the opener", async () => {
  // c6-r3-ha-04: Tab left the «المزيد» sheet 26 times in 60, and Escape put
  // focus on <body>.
  const client = await read("../app/slicer-client.tsx");
  const effect = client.slice(client.indexOf("const sheetOpenerRef = useRef"), client.indexOf("}, [sheetOpen]);"));
  assert.ok(effect.length > 200, "the modal effect is findable");
  assert.match(effect, /sheetOpenerRef\.current = active instanceof HTMLElement && active !== document\.body \? active : null;/, "the opener is remembered when a sheet opens");
  assert.match(effect, /sheetRef\.current\?\.closest<HTMLElement>\("\.sheet-backdrop"\)/);
  assert.match(effect, /if \(child !== backdrop\) \(child as HTMLElement\)\.inert = true;/, "every sibling of the backdrop goes inert");
  assert.match(effect, /new MutationObserver\(hide\)/, "including one that renders while the sheet is open");
  assert.match(effect, /for \(const child of page\.children\) \(child as HTMLElement\)\.inert = false;/, "nothing stays inert after it closes");
  assert.match(effect, /opener\?\.isConnected && !opener\.closest\("\[inert\]"\)\) opener\.focus\(/, "focus goes back to the opener");
  // It runs before the effect that moves focus into the sheet, so the opener
  // is still the focused element when it is read.
  assert.ok(client.indexOf("}, [sheetOpen]);") < client.indexOf("sheetRef.current?.focus();"), "the opener is read before focus moves into the sheet");
  // Tab and Shift+Tab wrap at the two ends of the sheet.
  const keys = client.slice(client.indexOf("sheetRef.current?.focus();"), client.indexOf("}, [sheet]);", client.indexOf("sheetRef.current?.focus();")));
  assert.match(keys, /if \(event\.key !== "Tab"\) return;/);
  assert.match(keys, /dialog\.querySelectorAll<HTMLElement>\(SHEET_TABBABLE\)/);
  assert.match(keys, /event\.preventDefault\(\);\s*last\.focus\(\);/);
  assert.match(keys, /event\.preventDefault\(\);\s*first\.focus\(\);/);
  assert.match(client, /<div className="sheet-backdrop"[\s\S]{0,200}?<section\s+ref=\{sheetRef\}/, "the sheet is the child of the backdrop");
});

test("a tap on a sheet's backdrop closes the sheet and reaches nothing under it", async () => {
  // c6fix-r1-ha-01: the backdrop closed the sheet on pointerdown. On a touch
  // screen the click of the tap is hit-tested after pointerup, when the
  // backdrop was already gone, so it landed on the top bar under it: the back
  // chevron left the Studio, «حفظ» saved and «استيراد» opened the file picker.
  // tests/browser-batch-d.mjs taps those points on a phone.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /<div className="sheet-backdrop" onPointerDown=\{pressBackdrop\} onClick=\{closeFromBackdrop\}>/);
  const press = client.slice(client.indexOf("const pressBackdrop = useCallback("), client.indexOf("}, []);", client.indexOf("const pressBackdrop = useCallback(")));
  assert.match(press, /backdropPressRef\.current = event\.target === event\.currentTarget;/, "pointerdown only marks the press");
  assert.doesNotMatch(press, /setSheet/, "and never closes the sheet");
  const close = client.slice(client.indexOf("const closeFromBackdrop = useCallback("), client.indexOf("}, []);", client.indexOf("const closeFromBackdrop = useCallback(")));
  assert.match(close, /if \(pressedHere && event\.target === event\.currentTarget\) setSheet\(null\);/, "the click of a press that began on the backdrop closes it");
  assert.doesNotMatch(client, /className="sheet-backdrop" onPointerDown=\{\(event\) => \{[^}]*setSheet\(null\)/);
});

// --------------------------------------------------------------- c6fix round 2

test("a key that moves the model anywhere on the page makes the result stale, and the export reads the scene again", async () => {
  // c6fix-r2-ha-01: the engine nudges the selected model on a keydown on
  // window. An arrow pressed on «المزيد», on «Print & export» or on the G-code
  // tile itself moved the model 10 mm, and the banner kept «نتيجة التقطيع
  // جاهزة» while the tile exported the G-code of the old position: the edit
  // listeners sat on the engine's shadow roots only, and the keyup of that
  // press never reached them. tests/browser-shell-keys.mjs presses the keys.
  const { EngineAdapter } = await loadAppModule("engine-adapter");
  const previous = { window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const target = new EventTarget();
  const bound = [];
  globalThis.window = {
    addEventListener: (type, listener, options) => { bound.push(["add", type, options]); target.addEventListener(type, listener, options); },
    removeEventListener: (type, listener, options) => { bound.push(["remove", type, options]); target.removeEventListener(type, listener, options); },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  try {
    const adapter = new EngineAdapter();
    let signals = 0;
    adapter.onSceneEdit(() => { signals += 1; });
    adapter.attach({ querySelectorAll: () => [] });
    assert.deepEqual(bound.filter(([how, type]) => how === "add" && type === "keyup").map(([, , options]) => options), [{ capture: true, passive: true }],
      "one keyup listener on window, in the capture phase, passive");
    target.dispatchEvent(new Event("keyup"));
    await Promise.resolve();
    assert.equal(signals, 1, "a keyup outside every engine root is a candidate edit");
    adapter.detach();
    assert.ok(bound.some(([how, type, options]) => how === "remove" && type === "keyup" && options?.capture === true), "detach unbinds it");
    target.dispatchEvent(new Event("keyup"));
    await Promise.resolve();
    assert.equal(signals, 1, "and nothing is heard after detach");
  } finally {
    globalThis.window = previous.window;
    globalThis.MutationObserver = previous.MutationObserver;
  }

  // A result is judged on the scene read at the moment of asking.
  const { resultMatches } = await loadAppModule("hooks/use-slicing-state");
  const stored = { sceneFingerprint: "1,0.000,0.000,0.000", settingsRevision: 2 };
  assert.equal(resultMatches(stored, { sceneFingerprint: "1,0.000,0.000,0.000", settingsRevision: 2 }), true, "the same scene and settings: fresh");
  assert.equal(resultMatches(stored, { sceneFingerprint: "1,-10.000,0.000,0.000", settingsRevision: 2 }), false, "moved 10 mm: stale");
  assert.equal(resultMatches(stored, { sceneFingerprint: "1,0.000,0.000,0.000", settingsRevision: 3 }), false, "a setting changed: stale");
  assert.equal(resultMatches(stored, { sceneFingerprint: null, settingsRevision: 2 }), true, "no engine to read: the settings decide");

  const [hook, client] = await Promise.all([read("../app/hooks/use-slicing-state.ts"), read("../app/slicer-client.tsx")]);
  assert.match(hook, /const liveFingerprint = useCallback\(\(\): string \| null => adapterRef\.current\?\.sceneFingerprint\(\) \?\? null, \[\]\);/);
  assert.match(hook, /const isFresh = useCallback\(\(result: StoredSliceResult\) => resultMatches\(result, \{\s*sceneFingerprint: liveFingerprint\(\),\s*settingsRevision: settingsRevisionRef\.current,\s*\}\)/);
  assert.match(hook, /if \(rejected && rejectionHolds\(rejected, \{\s*sceneFingerprint: liveFingerprint\(\) \?\? rejected\.sceneFingerprint,/);
  // At export time: the state catches up with the scene, and a stale file is refused.
  const fresh = hook.slice(hook.indexOf("const freshGcodeFile"), hook.indexOf("const staleGcodeFile"));
  assert.match(fresh, /const live = liveFingerprint\(\);\s*if \(live !== null && live !== sceneFingerprint\) setSceneFingerprint\(live\);\s*const stored = results\(\)\.get\(plate\);\s*if \(!stored \|\| !isFresh\(stored\)\) return null;/);
  // Every G-code the shell hands out goes through it.
  assert.match(client, /return slicing\.freshGcodeFile\(selectedPlate, name\);/);
  assert.match(client, /const gcodeFile = slicing\.freshGcodeFile\(selectedPlate, `\$\{baseName\}\.gcode`\);/);
});

test("the Settings switch is named by its label and is a 44 px target around the same track", async () => {
  // c6fix-r2-ha-03: «switch» with no name, in a 52 x 30 box.
  const [setup, css] = await Promise.all([read("../app/components/sheets/setup.tsx"), read("../app/globals.css")]);
  assert.match(setup, /<strong id="setup-support-label">\{t\.support\}<\/strong>/);
  assert.match(setup, /role="switch" aria-checked=\{props\.support\} aria-labelledby="setup-support-label"/);
  const rule = /\n\.switch \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /width: 52px;/);
  assert.match(rule, /height: var\(--tap-min\);/, "44 px tall");
  assert.match(rule, /padding: 10px 3px;/, "the knob sits where it sat: 3 px inside a track 7 px in");
  assert.match(rule, /background: transparent;/, "the box is the target, not the track");
  // The track is the same 52 x 30 pill: 44 - 2 x 7 tall.
  assert.match(css, /\n\.switch::before \{ content: ""; position: absolute; inset: 7px 0; border-radius: 99px; background: var\(--track\); \}/);
  assert.match(css, /\n\.switch\.on::before \{ background: var\(--accent-strong\); \}/);
  assert.match(css, /\n\.switch i \{ position: relative;/, "the knob paints above the track");
  assert.match(css, /--tap-min: 44px;/);
});

test("the Settings tiers are radiogroups that say which tier is in force, with a check mark", async () => {
  // c6fix-r2-ha-05: Quality, Strength and the infill pattern were plain
  // buttons; the chosen one had a gold edge and gold text and nothing else.
  const [setup, css] = await Promise.all([read("../app/components/sheets/setup.tsx"), read("../app/globals.css")]);
  const tiles = setup.slice(setup.indexOf("function RadioTiles"), setup.indexOf("export interface SetupSheetProps"));
  assert.match(tiles, /<div className=\{props\.className\} role="radiogroup" aria-label=\{props\.label\}>/);
  assert.match(tiles, /role="radio"\s+aria-checked=\{checked\}/);
  assert.match(tiles, /\{checked && <i className="tier-check" aria-hidden="true"><Icon name="check" \/><\/i>\}/);
  for (const [label, value, choose] of [["t.quality", "props.quality", "props.onQuality(id)"], ["t.strength", "props.strength", "props.onStrength(id)"], ["t.infillPattern", "props.infill", "props.onInfill(id)"]]) {
    const at = setup.indexOf(`label={${label}}`);
    assert.ok(at > 0, `${label} is a radiogroup`);
    const block = setup.slice(setup.lastIndexOf("<RadioTiles", at), setup.indexOf("/>", at));
    assert.ok(block.includes(`value={${value}}`) && block.includes(`onChoose={(id) => ${choose}}`), `${label} chooses ${value}`);
  }
  assert.doesNotMatch(setup, /<button key=\{id\} className=\{props\.(quality|strength|infill) === id/, "no tier is a plain button any more");
  assert.match(css, /\.segmented-control button \{ position: relative;/);
  assert.match(css, /\.tier-check \{ position: absolute;/);
});

test("the message row counts in the reader's language and never names an engine key", async () => {
  // c6fix-r2-ha-06: «… استبدل 1 من إعداداتك المعدّلة: layer_height.»,
  // «تم ترتيب 1 مجسمًا على 1 Plate.», "Arranged 1 objects across 1 plates."
  // and "Turned 1 objects."
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const say = (locale, key, values) => templateText(DICTIONARIES[locale][key], values, locale);
  assert.equal(say("ar", "arrangeDone", { models: 1, plates: 1 }), "تم ترتيب مجسم واحد على Plate واحدة.");
  assert.equal(say("ar", "arrangeDone", { models: 2, plates: 1 }), "تم ترتيب مجسمين على Plate واحدة.");
  assert.equal(say("ar", "arrangeDone", { models: 3, plates: 2 }), "تم ترتيب 3 مجسمات على 2 Plate.");
  assert.equal(say("ar", "arrangeDone", { models: 11, plates: 3 }), "تم ترتيب 11 مجسمًا على 3 Plate.");
  assert.equal(say("ar", "orientPresetDone", { count: 1 }), "تم تغيير اتجاه مجسم واحد.");
  assert.equal(say("ar", "orientPresetDone", { count: 2 }), "تم تغيير اتجاه مجسمين.");
  assert.equal(say("ar", "orientPresetDone", { count: 5 }), "تم تغيير اتجاه 5 مجسمات.");
  assert.equal(say("ar", "orientDone", { oriented: 1, total: 1 }), "المجسمات الموجّهة للطباعة: 1 من 1.");
  assert.equal(say("ar", "presetTookEdits", { count: 1 }), "استبدل الإعداد الجاهز الجديد إعدادًا واحدًا من إعداداتك المعدّلة، وبقيت بقية تعديلاتك كما هي.");
  assert.equal(say("ar", "presetTookEdits", { count: 2 }), "استبدل الإعداد الجاهز الجديد إعدادين من إعداداتك المعدّلة، وبقيت بقية تعديلاتك كما هي.");
  assert.equal(say("ar", "presetTookEdits", { count: 4 }), "استبدل الإعداد الجاهز الجديد 4 إعدادات من إعداداتك المعدّلة، وبقيت بقية تعديلاتك كما هي.");
  assert.equal(say("en", "arrangeDone", { models: 1, plates: 1 }), "Arranged 1 object across 1 plate.");
  assert.equal(say("en", "arrangeDone", { models: 3, plates: 2 }), "Arranged 3 objects across 2 plates.");
  assert.equal(say("en", "orientPresetDone", { count: 1 }), "Turned 1 object.");
  assert.equal(say("en", "orientPresetDone", { count: 2 }), "Turned 2 objects.");
  assert.equal(say("en", "orientDone", { oriented: 1, total: 1 }), "Oriented 1 of 1 object for printing.");
  assert.equal(say("en", "orientDone", { oriented: 2, total: 3 }), "Oriented 2 of 3 objects for printing.");
  assert.equal(say("en", "presetTookEdits", { count: 1 }), "The new preset replaced 1 setting you had changed. Everything else you edited was kept.");
  assert.equal(say("en", "presetTookEdits", { count: 3 }), "The new preset replaced 3 settings you had changed. Everything else you edited was kept.");
  // Sorani keeps the noun singular after a number; the verb agrees.
  assert.equal(say("ckb", "arrangeDone", { models: 1, plates: 1 }), "1 تەن لەسەر 1 Plate ڕیز کرا.");
  assert.equal(say("ckb", "arrangeDone", { models: 3, plates: 2 }), "3 تەن لەسەر 2 Plate ڕیز کران.");
  assert.equal(say("ckb", "orientDone", { oriented: 1, total: 2 }), "1 لە 2 تەن بۆ چاپکردن ئاراستە کرا.");
  assert.equal(say("ckb", "orientDone", { oriented: 2, total: 2 }), "2 لە 2 تەن بۆ چاپکردن ئاراستە کران.");
  assert.equal(say("ckb", "presetTookEdits", { count: 1 }), "ڕێکخستنە ئامادەکراوە نوێیەکە 1 لە ڕێکخستنە دەستکاریکراوەکانت گۆڕی. ئەوانی تر وەک خۆی مانەوە.");
  for (const locale of ["ar", "en", "ckb"]) {
    assert.doesNotMatch(DICTIONARIES[locale].presetTookEdits, /\{names\}/, `${locale}: no slot for engine keys`);
    for (const key of ["arrangeDone", "orientDone", "orientPresetDone", "presetTookEdits"]) {
      assert.doesNotMatch(say(locale, key, { models: 1, plates: 1, oriented: 1, total: 1, count: 1 }), /[{}]|layer_height/, `${locale} ${key}`);
    }
  }
  // The shell passes the count and the locale, never the keys.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /templateText\(text\.presetTookEdits, \{ count: carried\.overwritten\.length \}, localeRef\.current\)/);
  assert.doesNotMatch(client, /carried\.overwritten\.slice|names: carried/);
  assert.match(client, /templateText\(t\.arrangeDone, \{ models: result\.arrangedCount, plates: Math\.max\(1, result\.platesUsed\) \}, locale\)/);
  assert.match(client, /templateText\(t\.orientDone, \{ oriented: result\.orientedCount, total \}, locale\)/);
  assert.match(client, /templateText\(t\.orientPresetDone, \{ count: result\.changedCount \}, locale\)/);
});

test("the Settings tiers are named in Arabic, English and Sorani, the walls counted", async () => {
  // c6fix-r2-ha-07: «Fine 0.12 mm» and «Light 10% · 2 walls» in the Arabic
  // and Sorani sheet. The infill patterns keep the engine's own names.
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const NAMES = ["qualityFine", "qualityStandard", "qualityDraft", "strengthLight", "strengthStandard", "strengthStrong"];
  for (const key of NAMES) {
    const { en, ar, ckb } = { en: DICTIONARIES.en[key], ar: DICTIONARIES.ar[key], ckb: DICTIONARIES.ckb[key] };
    assert.ok(en && ar && ckb, `${key} exists in all three`);
    assert.notEqual(ckb, ar, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    assert.doesNotMatch(ar, /[A-Za-z]/, `${key}: Arabic «${ar}»`);
    assert.doesNotMatch(ckb, /[A-Za-z]/, `${key}: Sorani «${ckb}»`);
  }
  assert.deepEqual([DICTIONARIES.en.qualityFine, DICTIONARIES.en.qualityStandard, DICTIONARIES.en.qualityDraft], ["Fine", "Standard", "Draft"]);
  const walls = (locale, count) => templateText(DICTIONARIES[locale].wallsCount, { count }, locale);
  assert.deepEqual([1, 2, 3, 11].map((n) => walls("ar", n)), ["جدار واحد", "جداران", "3 جدران", "11 جدارًا"]);
  assert.deepEqual([1, 2, 3].map((n) => walls("en", n)), ["1 wall", "2 walls", "3 walls"]);
  assert.deepEqual([2, 3].map((n) => walls("ckb", n)), ["2 دیوار", "3 دیوار"]);

  const [setup, profiles, client] = await Promise.all([read("../app/components/sheets/setup.tsx"), read("../app/printer-profiles.ts"), read("../app/slicer-client.tsx")]);
  assert.match(setup, /const qualityName: Record<QualityId, string> = \{ fine: t\.qualityFine, standard: t\.qualityStandard, draft: t\.qualityDraft \};/);
  assert.match(setup, /const strengthName: Record<StrengthId, string> = \{ light: t\.strengthLight, standard: t\.strengthStandard, strong: t\.strengthStrong \};/);
  assert.match(setup, /templateText\(t\.wallsCount, \{ count: STRENGTH\[id\]\.walls \}, locale\)/);
  assert.doesNotMatch(setup, /(QUALITY|STRENGTH)\[id\]\.label|\swalls<|} walls/);
  assert.match(setup, /title: INFILL\[id\]\.label,/, "the engine's pattern names stay");
  // From the Quality table to the comment that opens the infill table.
  const tables = profiles.slice(profiles.indexOf("export const QUALITY"), profiles.indexOf("/**", profiles.indexOf("export const STRENGTH")));
  assert.match(tables, /export const STRENGTH: Record<StrengthId, \{ infill: number; walls: number \}>/);
  assert.doesNotMatch(tables, /label:/, "the tiers carry numbers, the dictionaries carry the names");
  assert.match(client, /<SetupSheet\s+t=\{t\}\s+locale=\{locale\}/);
});

test("the About sheet's legal summary and source link are 44 px targets", async () => {
  // c6fix-r2-ha-08: 360 x 39 and 336 x 38.
  const css = await read("../app/globals.css");
  assert.match(css, /\.legal-details summary \{ min-height: var\(--tap-min\); padding: 11px 12px; line-height: 22px;/);
  assert.match(css, /\.legal-details a \{ margin: 0 12px 12px; min-height: var\(--tap-min\);/);
  assert.match(css, /\.more-links a \{ min-height: var\(--tap-min\);/, "as the «المزيد» copy of the link already was");
});

// --------------------------------------------------------------- c6fix round 3

test("an undo offer stands only over the objects it was raised over", async () => {
  // c6fix-r3-ha-01: «تراجع عن القص» stayed in the row after «حذف الكل» and a
  // ZIP import, and pressing it deleted the two imported parts and brought
  // the cut cube back. tests/browser-shell-keys.mjs presses it (09).
  const client = await read("../app/slicer-client.tsx");
  const lower = client.slice(client.indexOf("const lowerUndoOffers = useCallback"), client.indexOf("}, []);", client.indexOf("const lowerUndoOffers = useCallback")));
  for (const line of ["arrangeUndoRef.current = null;", "orientUndoRef.current = null;", "cutUndoRef.current = null;", "undoSceneIdsRef.current = null;",
    "setArrangeUndoAvailable(false);", "setOrientUndoAvailable(false);", "setCutUndoAvailable(false);"]) {
    assert.ok(lower.includes(line), `lowerUndoOffers: ${line}`);
  }
  // The offer remembers the ids of the scene the operation left.
  assert.match(client, /undoSceneIdsRef\.current = available \? sceneIdsKey\(adapter\.sceneSnapshot\(\)\.map\(\(snapshot\) => snapshot\.id\)\) : null;/);
  // Any objects event over other ids takes every offer down: delete, delete
  // all, duplicate, paste, split, the engine undo, an import.
  const handler = client.slice(client.indexOf("const handleEvent = useCallback"), client.indexOf("} else if (event.type === \"plateCount\")"));
  assert.match(handler, /const ids = event\.value\.map\(\(object\) => object\.id\);\s*[\s\S]*?if \(undoSceneIdsRef\.current !== null && sceneIdsKey\(ids\) !== undoSceneIdsRef\.current\) lowerUndoOffers\(\);/);
  // An import takes them down before its objects arrive, and so does a new project.
  const importer = client.slice(client.indexOf("restoreInFlightRef.current = true;"), client.indexOf("const importNotices: string[] = [];"));
  assert.match(importer, /lowerUndoOffers\(\);/);
  const fresh = client.slice(client.indexOf("const newProject = useCallback"), client.indexOf("const deleteAll = useCallback"));
  assert.match(fresh, /lowerUndoOffers\(\);/);
  // And an undo pressed over other ids refuses, restoring nothing.
  const take = client.slice(client.indexOf("const takeUndo = useCallback"), client.indexOf("const undoOrient = useCallback"));
  assert.match(take, /const offeredOver = undoSceneIdsRef\.current;\s*lowerUndoOffers\(\);\s*if \(!undo \|\| offeredOver === null \|\| sceneIdsKey\(adapter\.sceneSnapshot\(\)\.map\(\(snapshot\) => snapshot\.id\)\) !== offeredOver\) \{\s*setNotice\(t\.actionUnavailable\);\s*return;\s*\}/);
  assert.ok(take.indexOf("setNotice(t.actionUnavailable);") < take.indexOf("undo()"), "the check comes before the restore");
  for (const name of ["undoOrient", "undoCut", "undoArrange"]) {
    assert.match(client, new RegExp(`const ${name} = useCallback\\(\\(\\) => takeUndo\\(`), `${name} goes through takeUndo`);
  }
});

test("the Projects sheet tabs read ink on sand, are 44 px tall and walk with the arrows", async () => {
  // c6fix-r3-ha-02: the chosen tab was #fff on #DCBC8C, 1.81:1, 40 px tall,
  // every tab a tab stop, the tablist unnamed, aria-controls null.
  const [panel, css] = await Promise.all([read("../app/components/projects-panel.tsx"), read("../app/globals.css")]);
  assert.match(panel, /\.lpp-tabs button\{[^}]*min-height:var\(--tap-min,44px\)\}/);
  assert.match(panel, /\.lpp-views button\{[^}]*min-height:var\(--tap-min,44px\)[^}]*\}/);
  assert.match(panel, /\.lpp-tabs \.lpp-tab-active\{background:var\(--levo-accent,#3d6ef7\);color:var\(--levo-accent-ink,#fff\);/);
  assert.match(panel, /\.lpp-views \.lpp-tab-active\{[^}]*color:var\(--levo-accent-ink,#fff\);/);
  assert.match(panel, /\.lpp-primary\{[^}]*color:var\(--levo-accent-ink,#fff\)\}/);
  assert.doesNotMatch(panel, /var\(--levo-accent,#3d6ef7\);(?:border-color:transparent;)?color:#fff/, "no white on the accent fill");
  assert.match(css, /--levo-accent-ink: var\(--accent-ink\);/);
  // The ink on the accent passes 4.5:1 in both themes.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const dark = /:root\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
  const light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
  for (const [name, block] of [["dark", dark], ["light", light]]) {
    const accent = /--accent:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
    const ink = /--accent-ink:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
    assert.ok(accent && ink, `${name}: the accent tokens are readable`);
    assert.ok(ratio(accent, ink) >= 4.5, `${name}: ink on the accent is ${ratio(accent, ink).toFixed(2)}:1`);
  }
  // Tabs to the keyboard: named, one tab stop, the arrows walk, each controls its labelled panel.
  assert.match(panel, /<h2 id=\{tabId\("title"\)\}>\{t\.title\}<\/h2>\s*<div className="lpp-tabs" role="tablist" aria-labelledby=\{tabId\("title"\)\}>/);
  assert.match(panel, /role="tab"\s+id=\{tabId\(name\)\}\s+aria-selected=\{tab === name\}\s+aria-controls=\{tabPanelId\}\s+tabIndex=\{tab === name \? 0 : -1\}/);
  assert.match(panel, /const next = consumeRovingKey\(event, index, PANEL_TABS\.length\);\s*if \(next < 0\) return;\s*setTab\(PANEL_TABS\[next\]\);\s*tabRefs\.current\[next\]\?\.focus\(\);/);
  assert.match(panel, /<div className="lpp-panel" role="tabpanel" id=\{tabPanelId\} aria-labelledby=\{tabId\(tab\)\}>/);
  assert.match(panel, /role="tab"\s+id=\{tabId\(`view-\$\{v\}`\)\}\s+aria-selected=\{view === v\}\s+aria-controls=\{viewPanelId\}\s+tabIndex=\{view === v \? 0 : -1\}/);
  assert.match(panel, /const next = consumeRovingKey\(event, index, PANEL_VIEWS\.length\);/);
  assert.match(panel, /<div className="lpp-panel" role="tabpanel" id=\{viewPanelId\} aria-labelledby=\{tabId\(`view-\$\{view\}`\)\}>/);
});

test("the chosen connection way takes the sand selection and a check mark", async () => {
  // c6fix-r3-ha-03: the chosen tab was one shade off the track (1.16:1 in
  // light, 1.32:1 in dark), with no check mark.
  const [css, connect] = await Promise.all([read("../app/globals.css"), read("../app/components/sheets/connect.tsx")]);
  const rule = /\.connection-method-tabs button\[aria-selected="true"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule, "the chosen tab has its own rule");
  assert.match(rule, /background: var\(--gold-clay\);/);
  assert.match(rule, /box-shadow: var\(--clay-gold\);/);
  assert.match(rule, /color: var\(--gold-ink\);/);
  assert.doesNotMatch(css, /\.connection-method-tabs button\.active \{ border-color: var\(--line\); background: var\(--surface\);/);
  assert.match(connect, /<Icon name=\{mode === tab \? "check" : tab === "lan" \? "print"/);
  // A long name takes two lines rather than an ellipsis.
  assert.match(css, /\.connection-method-tabs span \{[^}]*-webkit-line-clamp: 2;/);
});

test("the viewport card's view buttons are one tab stop and keep their arrows", async () => {
  // c6fix-r3-ha-04: an arrow on expand, «إعادة العرض» or the bed view moved
  // the model 10 mm, and in the preview it stepped the layer slider.
  const card = await read("../app/components/mobile/viewport-card.tsx");
  assert.match(card, /role="toolbar" aria-label=\{t\.viewGroup\}/);
  assert.match(card, /const next = consumeRovingKey\(event, enabled\.indexOf\(index\), enabled\.length\);\s*if \(next < 0\) return;\s*setStop\(enabled\[next\]\);\s*refs\.current\[enabled\[next\]\]\?\.focus\(\);/);
  assert.match(card, /const enabled = overlay\.hasObjects \? \[EXPAND, RESET, BED\] : \[EXPAND, BED\];/);
  for (const name of ["EXPAND", "RESET", "BED"]) {
    assert.match(card, new RegExp(`tabIndex=\\{tabStop === ${name} \\? 0 : -1\\}\\s*onFocus=\\{\\(\\) => setStop\\(${name}\\)\\}\\s*onKeyDown=\\{\\(event\\) => onKeyDown\\(event, ${name}\\)\\}`), `${name} roves`);
  }
});

test("the cut and the import notices are counted in ar, en and ckb", async () => {
  // c6fix-r3-ha-05: «تم القص إلى 2 قطعة.», «تم توزيع 2 مجسمًا تلقائيًا على 1
  // Plate.», "1 models exceed the build area", «1 تەن … گەورەترن».
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const say = (locale, key, values) => templateText(DICTIONARIES[locale][key], values, locale);
  assert.equal(say("ar", "cutDone", { pieces: 2 }), "تم القص إلى قطعتين.");
  assert.equal(say("ar", "cutDone", { pieces: 3 }), "تم القص إلى 3 قطع.");
  assert.equal(say("ar", "zipArranged", { models: 2, plates: 1 }), "تم توزيع مجسمين تلقائيًا على Plate واحدة.");
  assert.equal(say("ar", "zipArranged", { models: 3, plates: 1 }), "تم توزيع 3 مجسمات تلقائيًا على Plate واحدة.");
  assert.equal(say("ar", "zipArranged", { models: 11, plates: 2 }), "تم توزيع 11 مجسمًا تلقائيًا على 2 Plate.");
  assert.equal(say("ar", "zipOversized", { count: 1 }), "يوجد مجسم واحد أكبر من مساحة الطباعة؛ تم توسيطه ويحتاج تصغيرًا أو تقسيمًا.");
  assert.equal(say("ar", "zipOversized", { count: 2 }), "يوجد مجسمان أكبر من مساحة الطباعة؛ تم توسيطهما ويحتاجان تصغيرًا أو تقسيمًا.");
  assert.equal(say("ar", "zipOverflow", { count: 1 }), "تعذر توزيع مجسم واحد لأن المحرر يدعم 9 Plates كحد أقصى؛ بقي في موضع الاستيراد للمراجعة اليدوية.");
  assert.equal(say("ar", "orientSkipped", { skipped: 1 }), "تعذّر قياس مجسم واحد منها فتُرك كما هو.");
  assert.equal(say("ar", "orientLocked", { locked: 2 }), "لم يُمسّ مجسمان مقفلان.");
  assert.equal(say("en", "cutDone", { pieces: 2 }), "Cut into 2 pieces.");
  assert.equal(say("en", "zipArranged", { models: 2, plates: 1 }), "Automatically arranged 2 models across 1 plate.");
  assert.equal(say("en", "zipOversized", { count: 1 }), "1 model exceeds the build area; it was centered and needs scaling or splitting.");
  assert.equal(say("en", "zipOversized", { count: 2 }), "2 models exceed the build area; they were centered and need scaling or splitting.");
  assert.equal(say("en", "zipOverflow", { count: 1 }), "1 model could not be distributed because the editor supports up to 9 plates; it remains at its imported position for manual review.");
  assert.equal(say("en", "orientSkipped", { skipped: 1 }), "1 could not be measured and was left alone.");
  assert.equal(say("en", "orientLocked", { locked: 1 }), "1 locked object was not touched.");
  // Sorani keeps the noun singular after a number; the verb agrees.
  assert.equal(say("ckb", "zipArranged", { models: 1, plates: 1 }), "1 تەن بە شێوەی خۆکار لەسەر 1 Plate دابەش کرا.");
  assert.equal(say("ckb", "zipArranged", { models: 2, plates: 1 }), "2 تەن بە شێوەی خۆکار لەسەر 1 Plate دابەش کران.");
  assert.equal(say("ckb", "zipOversized", { count: 1 }), "1 تەن لە ڕووبەری چاپکردن گەورەترە؛ ناوەندگیر کرا و پێویستی بە بچووککردنەوە یان دابەشکردنە.");
  assert.equal(say("ckb", "zipOversized", { count: 3 }), "3 تەن لە ڕووبەری چاپکردن گەورەترن؛ ناوەندگیر کران و پێویستیان بە بچووککردنەوە یان دابەشکردنە.");
  assert.equal(say("ckb", "zipOverflow", { count: 1 }), "1 تەن دابەش نەکرا چونکە دەستکاریکەرەکە زۆرترین 9 Plate پشتگیری دەکات؛ لە شوێنی هاوردەکردنی مایەوە بۆ پێداچوونەوەی دەستی.");
  assert.equal(say("ckb", "orientSkipped", { skipped: 1 }), "1 نەپێورا و وەک خۆی مایەوە.");
  for (const locale of ["ar", "en", "ckb"]) {
    assert.notEqual(DICTIONARIES.ckb.zipOversized, DICTIONARIES.ar.zipOversized);
    for (const key of ["cutDone", "zipArranged", "zipOversized", "zipOverflow", "orientSkipped", "orientLocked"]) {
      for (const n of [1, 2, 3, 11]) {
        assert.doesNotMatch(say(locale, key, { pieces: n, models: n, plates: n, count: n, skipped: n, locked: n }), /[{}#]/, `${locale} ${key} ${n}`);
      }
    }
  }
  // The shell passes the reader's language at every one of these calls.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /templateText\(t\.zipArranged, \{ models: entry\.models, plates: entry\.plates \}, locale\)/);
  assert.match(client, /templateText\(t\.zipOversized, \{ count: entry\.count \}, locale\)/);
  assert.match(client, /return templateText\(t\.zipOverflow, \{ count: entry\.count \}, locale\);/);
  assert.match(client, /templateText\(t\.cutDone, \{ pieces: result\.pieceIds\.length \}, locale\)/);
  assert.match(client, /templateText\(t\.orientSkipped, \{ skipped: result\.skippedCount \}, locale\)/);
  assert.match(client, /templateText\(t\.orientLocked, \{ locked: result\.lockedCount \}, locale\)/);
  assert.match(client, /templateText\(t\.zipOverflow, \{ count: result\.unseatedCount \}, localeRef\.current\)/);
  assert.doesNotMatch(client, /templateText\(t\.(?:cutDone|zipArranged|zipOversized|zipOverflow|orientSkipped|orientLocked), \{[^}]*\}\)/, "no counted notice without its language");
});

test("a window key that changes nothing is not an edit to keep: it never marks a synced project unsaved", async () => {
  // R3-REG-01/02: the window keyup of c6fix-r2-ha-01 marked the session
  // dirty. «Make this the current version» pressed with Enter then skipped
  // the reload (the editor kept the old version, said «Synced», and the
  // next save met a 409), one Tab flipped the badge to «Unsaved changes»,
  // and the phone back chevron asked the leave question with nothing
  // unsaved. tests/browser-account-keys.mjs presses them.
  const { EngineAdapter } = await loadAppModule("engine-adapter");
  const previous = { window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const target = new EventTarget();
  globalThis.window = {
    addEventListener: (type, listener, options) => target.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) => target.removeEventListener(type, listener, options),
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  try {
    const adapter = new EngineAdapter();
    const signals = [];
    adapter.onSceneEdit((signal) => signals.push(signal.keysOnly));
    adapter.attach({ querySelectorAll: () => [] });
    target.dispatchEvent(new Event("keyup"));
    await Promise.resolve();
    assert.deepEqual(signals, [true], "a keyup on window alone is a key-only signal");
    adapter.notifySceneEdited();
    await Promise.resolve();
    assert.deepEqual(signals, [true, false], "a mutation through the adapter is never key-only");
    target.dispatchEvent(new Event("keyup"));
    adapter.notifySceneEdited();
    await Promise.resolve();
    assert.deepEqual(signals, [true, false, false], "a window key and a mutation in one tick: not key-only");
    // Inside an engine shadow root a key is an edit as it always was, except
    // a key that only moves the focus: the Tabs through the engine canvas and
    // its plate tabs on the way to the phone back chevron.
    const key = (name) => Object.assign(new Event("keyup"), { key: name });
    adapter.onRootEditEvent(key("ArrowLeft"));
    await Promise.resolve();
    assert.deepEqual(signals.slice(3), [false], "an arrow inside the engine is not key-only");
    adapter.onRootEditEvent(new Event("pointerup"));
    await Promise.resolve();
    assert.deepEqual(signals.slice(4), [false], "a pointer inside the engine is not key-only");
    adapter.onRootEditEvent(key("Tab"));
    adapter.onRootEditEvent(key("Shift"));
    target.dispatchEvent(new Event("keyup"));
    await Promise.resolve();
    assert.deepEqual(signals.slice(5), [true], "Tab and Shift inside the engine, with the window keyup: key-only");
    target.dispatchEvent(new Event("keyup"));
    await Promise.resolve();
    assert.deepEqual(signals.slice(6), [true], "and the next window key alone is key-only again");
    adapter.detach();
  } finally {
    globalThis.window = previous.window;
    globalThis.MutationObserver = previous.MutationObserver;
  }
  // Autosave asks the fingerprint before it calls a window key an edit; the
  // objects event resets what it compares with (an opened or restored project).
  const client = await read("../app/slicer-client.tsx");
  const listener = client.slice(client.indexOf("const autosaveSceneRef = useRef(\"\");"), client.indexOf("}, [adapter, markDirty]);"));
  assert.match(listener, /const scene = adapter\.sceneFingerprint\(\);\s*const moved = scene !== autosaveSceneRef\.current;\s*autosaveSceneRef\.current = scene;/);
  assert.match(listener, /if \(signal\.keysOnly && !moved\) return;\s*markDirty\(\);/);
  assert.match(client, /autosaveSceneRef\.current = adapter\.sceneFingerprint\(\);\s*const ids = event\.value\.map/);
  // The slice result is still judged on the live scene, so a nudge stays stale.
  const hook = await read("../app/hooks/use-slicing-state.ts");
  assert.match(hook, /return adapter\.onSceneEdit\(refreshSceneFingerprint\);/);
});
