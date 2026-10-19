/**
 * P1-10 client half: the Simple/Advanced mode.
 *
 *   - Simple is the default for everyone (owner decision S6), and the choice
 *     is kept on the server with a local mirror (S7): the REAL
 *     app/studio-mode.ts reconcile/load/save logic, driven through its storage
 *     seam and an in-memory /api/prefs;
 *   - one account's mirrored choice never applies to another account or to a
 *     guest on the same device (the namespaces the drafts use, acceptance 02);
 *   - Simple hides the engine side panel at EVERY width and only the engine
 *     controls that do not work — never a warning, the stale banner, the
 *     slicing estimate or the slice action (acceptance 10, regression): the
 *     real EDITOR_SHADOW_CSS, the shell's own wiring, and the installed
 *     engine's event surface;
 *   - the localised certificate-trust prompt.
 *
 * The engine-side check that every hidden control is really dead lives in
 * tests/editor-capabilities.test.mjs, beside the rest of the engine contract.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall back */
      }
    }
    return nextResolve(specifier, context);
  },
});

const mode = await import("../app/studio-mode.ts");
const theme = await import("../app/editor-theme.ts");
const { namespaceForUser, GUEST_NAMESPACE } = await import("../app/project-store.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** /api/prefs for one account, in memory; `fail` makes every call throw. */
function fakeApi({ stored = null, fail = false } = {}) {
  const calls = [];
  let row = stored;
  return {
    calls,
    get row() {
      return row;
    },
    async get() {
      calls.push(["GET"]);
      if (fail) throw new Error("offline");
      return { mode: row ?? "simple", stored: row !== null };
    },
    async put(next) {
      calls.push(["PUT", next]);
      if (fail) throw new Error("offline");
      row = next;
      return { mode: row, stored: true };
    },
  };
}

test("Simple is the default for everyone", () => {
  assert.equal(mode.DEFAULT_STUDIO_MODE, "simple");
  assert.deepEqual([...mode.STUDIO_MODES], ["simple", "advanced"]);
  assert.deepEqual(mode.reconcileMode(null, null), { mode: "simple", push: null });
  assert.deepEqual(mode.reconcileMode(null, { mode: "simple", stored: false }), { mode: "simple", push: null });
});

test("reconcile: a stored server choice wins; a device choice the server never got is pushed up", () => {
  assert.deepEqual(mode.reconcileMode("simple", { mode: "advanced", stored: true }), { mode: "advanced", push: null });
  assert.deepEqual(mode.reconcileMode("advanced", { mode: "simple", stored: true }), { mode: "simple", push: null });
  assert.deepEqual(mode.reconcileMode("advanced", { mode: "simple", stored: false }), { mode: "advanced", push: "advanced" });
  // Server unreachable: the mirror stands, nothing is pushed blind.
  assert.deepEqual(mode.reconcileMode("advanced", null), { mode: "advanced", push: null });
});

test("load/save: guests use the mirror only; a signed-in account syncs with the server and its mirror follows", async () => {
  const storage = memoryStorage();
  mode.setModeStorageForTests(storage);
  try {
    const guest = GUEST_NAMESPACE;
    const userA = namespaceForUser("usr_a");
    const api = fakeApi();

    // A guest: no network at all.
    assert.equal(await mode.loadStudioMode({ namespace: guest, signedIn: false, api }), "simple");
    assert.equal(await mode.saveStudioMode({ namespace: guest, signedIn: false, api, mode: "advanced" }), false);
    assert.equal(await mode.loadStudioMode({ namespace: guest, signedIn: false, api }), "advanced");
    assert.deepEqual(api.calls, [], "a guest never calls /api/prefs");

    // Account A on this device: the guest's choice is NOT applied to it.
    assert.equal(await mode.loadStudioMode({ namespace: userA, signedIn: true, api }), "simple");
    assert.deepEqual(api.calls, [["GET"]], "nothing to push: the account never chose");
    // A chooses Advanced: mirror and server both get it.
    assert.equal(await mode.saveStudioMode({ namespace: userA, signedIn: true, api, mode: "advanced" }), true);
    assert.equal(api.row, "advanced");
    assert.equal(storage.getItem(mode.modeStorageKey(userA)), "advanced");

    // Another device (a fresh mirror) picks the account's choice up from the server.
    const otherDevice = memoryStorage();
    mode.setModeStorageForTests(otherDevice);
    assert.equal(await mode.loadStudioMode({ namespace: userA, signedIn: true, api }), "advanced");
    assert.equal(otherDevice.getItem(mode.modeStorageKey(userA)), "advanced", "the mirror follows the server");
  } finally {
    mode.setModeStorageForTests(null);
  }
});

test("a choice made while the server was unreachable survives and is pushed on the next load", async () => {
  const storage = memoryStorage();
  mode.setModeStorageForTests(storage);
  try {
    const ns = namespaceForUser("usr_offline");
    const down = fakeApi({ fail: true });
    assert.equal(await mode.saveStudioMode({ namespace: ns, signedIn: true, api: down, mode: "advanced" }), false);
    assert.equal(await mode.loadStudioMode({ namespace: ns, signedIn: true, api: down }), "advanced", "the mirror stands while offline");
    const up = fakeApi();
    assert.equal(await mode.loadStudioMode({ namespace: ns, signedIn: true, api: up }), "advanced");
    assert.deepEqual(up.calls, [["GET"], ["PUT", "advanced"]], "the device's choice is pushed, not overwritten by the default");
    assert.equal(up.row, "advanced");
  } finally {
    mode.setModeStorageForTests(null);
  }
});

test("account switch on one device: B never inherits A's mode, and the sign-out purge forgets A's", async () => {
  const storage = memoryStorage();
  mode.setModeStorageForTests(storage);
  try {
    const a = namespaceForUser("usr_a");
    const b = namespaceForUser("usr_b");
    await mode.saveStudioMode({ namespace: a, signedIn: true, api: fakeApi(), mode: "advanced" });
    assert.equal(mode.readModeMirror(b), null);
    assert.equal(await mode.loadStudioMode({ namespace: b, signedIn: true, api: fakeApi() }), "simple");
    mode.clearModeMirror(a);
    assert.equal(mode.readModeMirror(a), null);
    assert.ok(![...storage.map.keys()].some((k) => k.includes("usr_a")), "no trace of A's id is left in storage");
    // Garbage in storage is not a mode.
    storage.setItem(mode.modeStorageKey(b), "expert");
    assert.equal(mode.readModeMirror(b), null);
  } finally {
    mode.setModeStorageForTests(null);
  }
});

test("the /api/prefs client: same-origin credentials, JSON PUT, honest failure on 429 and 5xx", async () => {
  const seen = [];
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const api = mode.createStudioPrefsApi(async (input, init = {}) => {
    seen.push({ input, method: init.method ?? "GET", credentials: init.credentials, body: init.body ?? null });
    if (init.method === "PUT") return answer(200, { success: true, prefs: { mode: JSON.parse(init.body).mode }, stored: true });
    return answer(200, { success: true, prefs: { mode: "advanced" }, stored: true });
  });
  assert.deepEqual(await api.get(), { mode: "advanced", stored: true });
  assert.deepEqual(await api.put("simple"), { mode: "simple", stored: true });
  assert.deepEqual(seen, [
    { input: "/api/prefs", method: "GET", credentials: "same-origin", body: null },
    { input: "/api/prefs", method: "PUT", credentials: "same-origin", body: JSON.stringify({ mode: "simple" }) },
  ]);
  for (const status of [429, 500, 401]) {
    const failing = mode.createStudioPrefsApi(async () => answer(status, { success: false, code: "X" }));
    await assert.rejects(failing.get(), new RegExp(String(status)));
  }
  // An unknown mode from a newer server reads as Simple, never as garbage.
  const future = mode.createStudioPrefsApi(async () => answer(200, { success: true, prefs: { mode: "guided" }, stored: true }));
  assert.deepEqual(await future.get(), { mode: "simple", stored: true });
});

// ---------------------------------------------------------------------------
// What Simple hides, and what it must never hide
// ---------------------------------------------------------------------------

test("Simple hides the engine side panel at EVERY width — the rule outranks the desktop width rule", () => {
  const css = theme.EDITOR_SHADOW_CSS;
  const simpleRule = ':host([data-levo-mode="simple"]) .sidebar { display: none !important; }';
  assert.ok(css.includes(simpleRule), "the Simple rule is missing");
  // The desktop rule forces the panel open with !important; the Simple rule
  // must come after it (and is more specific), and must not sit inside any
  // width query — "every width" means no @media around it.
  const desktop = css.indexOf("@media (min-width: 900px)");
  const at = css.indexOf(simpleRule);
  assert.ok(desktop > 0 && at > desktop, "the Simple rule must come after the desktop width rule");
  const before = css.slice(0, at);
  const opened = (before.match(/\{/g) || []).length;
  const closed = (before.match(/\}/g) || []).length;
  assert.equal(opened, closed, "the Simple rule must be top-level, not inside a @media block");
});

test("Simple's own rules name no warning, the estimate, the status or the plate bar (the panel's contents: see the containment test)", () => {
  const css = theme.EDITOR_SHADOW_CSS;
  const simpleRules = css
    .split("\n")
    .filter((line) => line.includes('data-levo-mode="simple"'))
    .join("\n");
  for (const kept of ["stats-card", "slice-stats", "bed-warn", "over-bed", "vp-status", "plate-bar", "slice-warn", "slice-err", "slice-notice", "topbar"]) {
    assert.ok(!simpleRules.includes(kept), `Simple mode must not hide ${kept}`);
  }
  // Only the listed dead controls (and the dividers that introduced them),
  // nothing broader than a test id.
  const ruleLines = simpleRules.split("\n").filter((line) => !line.includes(".sidebar"));
  const hidden = [...ruleLines[0].matchAll(/\[data-testid="([^"]+)"\]/g)].map((m) => m[1]);
  assert.deepEqual(hidden, [...theme.SIMPLE_MODE_HIDDEN_ENGINE_TOOLS]);
  assert.match(ruleLines[1], /^\s*:host\(\[data-levo-mode="simple"\]\) \.vtt-sep:has\(\+ \[data-testid="tool-arrange"\]\)/);
  assert.equal(ruleLines.length, 2);
});

test("containment: no engine warning or recovery control is trapped inside the side panel Simple hides", async () => {
  // Hiding the panel hides EVERYTHING inside it, so the CSS check above is
  // not enough: walk the installed engine's render tree and list every
  // warning, error, notice or recovery control inside <aside className:
  // "sidebar">. Each one must also reach the person by another path — an
  // engine event the shell shows, or the shell's own copy of it — in both
  // modes. A new one the engine adds fails here until the shell carries it.
  const { createRequire } = await import("node:module");
  const acorn = createRequire(new URL("../package.json", import.meta.url))("acorn");
  const [engine, client, adapterSource] = await Promise.all([
    read("../node_modules/three-slicer/viewer/dist/Viewport.js"),
    read("../app/slicer-client.tsx"),
    read("../app/engine-adapter.ts"),
  ]);
  const ast = acorn.parse(engine, { ecmaVersion: "latest", sourceType: "module" });
  const isElement = (node) =>
    node?.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "createElement";
  const literalProps = (node) => {
    const out = {};
    const props = node.arguments[1];
    if (props?.type === "ObjectExpression") {
      for (const prop of props.properties) {
        if (prop.type === "Property" && prop.value.type === "Literal") out[prop.key.name ?? prop.key.value] = prop.value.value;
      }
    }
    return out;
  };
  const walk = (node, visit) => {
    if (!node || typeof node.type !== "string") return;
    visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) walk(child, visit);
      else if (value && typeof value.type === "string") walk(value, visit);
    }
  };
  const asides = [];
  walk(ast, (node) => {
    if (isElement(node) && node.arguments[0].value === "aside" && literalProps(node).className === "sidebar") asides.push(node);
  });
  assert.equal(asides.length, 1, "the engine's side panel was not found");

  // The unlabelled side warning is the slow-slice one: its text is the state
  // the engine exposes as setTriWarn.
  const triWarnState = (node) => {
    const child = node.arguments[3];
    if (child?.type !== "Identifier") return false;
    const setter = engine.match(new RegExp(`\\[${child.name}, (\\w+)\\] = \\w+\\(""\\)`))?.[1];
    return Boolean(setter) && engine.includes(`setTriWarn: ${setter}`);
  };
  const found = [];
  walk(asides[0], (node) => {
    if (!isElement(node)) return;
    const props = literalProps(node);
    const cls = String(props.className ?? "");
    const id = String(props["data-testid"] ?? "");
    if (!/warn|err|notice/.test(cls) && !/warn|err|notice|retry/.test(id)) return;
    found.push(id ? `testid:${id}` : triWarnState(node) ? "tri-warning" : `unlabelled:${cls}`);
  });

  const delivered = {
    // Engine events the shell puts in its own message row.
    "testid:slice-notice": () => {
      assert.match(engine, /ft\(e, "notice", n\.notice\)/);
      assert.match(client, /event\.type === "notice"\) \{[\s\S]{0,400}setNotice\(event\.value\)/);
    },
    "testid:slice-err": () => {
      assert.match(engine, /ft\(e, "error", n\.error\)/);
      assert.match(client, /event\.type === "error"\) \{[\s\S]{0,1200}setError\(event\.value\)/);
    },
    // The retry offer: the shell's error row offers it and clicks the
    // engine's own button through the adapter (a contract test id).
    "testid:downgrade-retry": () => {
      assert.ok(engine.includes("All plates failed to slice (economy mode included) — try the simplified retry"));
      assert.match(adapterSource, /ENGINE_STATIC_TEST_IDS = \[[\s\S]*"downgrade-retry"[\s\S]*\] as const/);
      assert.match(client, /adapter\.isControlAvailable\("downgrade-retry"\)/);
      assert.match(client, /adapter\.clickControl\("downgrade-retry"\)/);
      assert.match(client, /\{error && downgradeOfferFor === error && <button className="message-action" data-levo-action="simplified-retry"/);
    },
    // Never an event: the shell counts the triangles itself, against the
    // engine's own threshold.
    "tri-warning": () => {
      assert.match(
        engine,
        /(\w+) > 1e5 && \w+\(`\$\{Math\.round\(\1\)\.toLocaleString\(\)\} triangles — slicing may take a while`\)/
      );
      assert.match(adapterSource, /export const HEAVY_IMPORT_TRIANGLES = 100_000;/);
      assert.match(client, /noteHeavyImport\(ids\)/);
      assert.match(client, /data-levo-warning="heavy-import"/);
    },
  };
  assert.ok(found.length >= 4, `expected the engine's panel warnings, found ${found.join(", ")}`);
  for (const entry of found) {
    assert.ok(entry in delivered, `${entry} sits inside the side panel Simple hides and reaches the person by no other path`);
    delivered[entry]();
  }
  // The shell's copies are shown in BOTH modes: nothing about them reads the mode.
  for (const marker of ['data-levo-warning="heavy-import"', 'data-levo-action="simplified-retry"']) {
    const at = client.indexOf(marker);
    assert.doesNotMatch(client.slice(at - 300, at + 300), /simpleMode|studioMode/);
  }
});

test("the shell's slow-slice warning counts what ONE import added, against the engine's threshold", async () => {
  const adapterMod = await import("../app/engine-adapter.ts");
  assert.equal(adapterMod.HEAVY_IMPORT_TRIANGLES, 100_000);
  assert.equal(adapterMod.isHeavyImport(100_000), false, "the engine warns only ABOVE 1e5");
  assert.equal(adapterMod.isHeavyImport(100_001), true);
  const scene = [
    { id: 1, name: "a", localPos: new Float32Array(9 * 60_000) },
    { id: 2, name: "b", localPos: new Float32Array(9 * 50_000) },
    { id: 3, name: "c", localPos: new Float32Array(9 * 10) },
  ];
  const hadWindow = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = { __vpApi: () => ({ sceneSnapshot: () => scene }) };
  try {
    const adapter = adapterMod.createEngineAdapter();
    assert.equal(adapter.triangleCountOf([1, 2]), 110_000);
    assert.equal(adapter.triangleCountOf([3]), 10);
    assert.equal(adapter.triangleCountOf([]), 0);
    assert.equal(adapterMod.isHeavyImport(adapter.triangleCountOf([1, 2])), true);
    assert.equal(adapterMod.isHeavyImport(adapter.triangleCountOf([1])), false);
  } finally {
    if (hadWindow) globalThis.window = previous;
    else delete globalThis.window;
  }
  // The warning text exists in all three languages with its {count} slot.
  const dictionaries = await import("../app/i18n/index.ts");
  for (const locale of ["ar", "en", "ckb"]) {
    const dict = dictionaries.DICTIONARIES[locale];
    assert.match(dict.heavyModelWarning, /\{count\}/, locale);
    assert.ok(dict.simplifiedRetry && dict.simplifiedRetryHelp, locale);
  }
  for (const key of ["heavyModelWarning", "simplifiedRetry", "simplifiedRetryHelp"]) {
    assert.notEqual(dictionaries.DICTIONARIES.ckb[key], dictionaries.DICTIONARIES.ar[key], `ckb.${key} is not the Arabic`);
  }
});

test("warnings reach the shell in Simple: engine errors and notices are events, the stats card sits outside the panel (acceptance 10)", async () => {
  const [client, engine] = await Promise.all([
    read("../app/slicer-client.tsx"),
    read("../node_modules/three-slicer/viewer/dist/Viewport.js"),
  ]);
  // The engine reports its slice error and notice as events, not only as
  // text inside the side panel Simple hides.
  assert.match(engine, /ft\(e, "error", n\.error\)/);
  assert.match(engine, /ft\(e, "notice", n\.notice\)/);
  // …and the shell puts both in its own message row, in every mode.
  assert.match(client, /event\.type === "notice"\) \{[\s\S]{0,400}setNotice\(event\.value\)/);
  assert.match(client, /event\.type === "error"\) \{[\s\S]{0,1200}setError\(event\.value\)/);
  // The stats card (estimate + over-bed warning) and the bed warning are
  // rendered OUTSIDE the engine's side panel: their elements come before
  // the panel's <aside> in the engine's render tree.
  const sidebarAt = engine.indexOf('className: "sidebar"');
  assert.ok(engine.indexOf('"data-testid": "slice-stats"') < sidebarAt);
  assert.ok(engine.indexOf('"data-testid": "bed-warn"') < sidebarAt);
  // The panels stay switched ON — Simple hides the side panel with CSS, it
  // never removes what the shell needs from the engine.
  const panels = client.slice(client.indexOf("const EDITOR_PANELS = {"), client.indexOf("} as unknown as NonNullable"));
  for (const name of ["statsCard", "bedWarn", "status", "plateBar", "sidebar", "sliceBar"]) {
    assert.match(panels, new RegExp(`${name}: true`), `${name} must stay on`);
  }
  // The shell's own warnings do not depend on the mode.
  const slotAt = client.indexOf("const heavyImportText =");
  assert.ok(slotAt > 0, "the message slot is computed before the render");
  const slot = client.slice(slotAt, client.indexOf("return (", slotAt));
  const message = client.slice(client.indexOf("{messageText && <div"), client.indexOf("{messageText && <div") + 200);
  const stale = client.slice(client.indexOf("{staleBannerShown && <div"), client.indexOf("{staleBannerShown && <div") + 200);
  for (const block of [slot, message, stale]) {
    assert.ok(block.length > 100);
    assert.doesNotMatch(block, /simpleMode|studioMode/);
  }
  // The mode reaches the engine through its host attribute.
  assert.match(client, /adapter\.setHostAttribute\("data-levo-mode", studioMode\.mode\)/);
});

test("one message slot: the slow-slice warning beats the generic import notice, the outdated-result banner is never hidden by it, and a slice clears it", async () => {
  const client = await read("../app/slicer-client.tsx");
  const slot = client.slice(client.indexOf("const heavyImportText ="), client.indexOf("return (", client.indexOf("const heavyImportText =")));
  // Only a notice made of nothing but «files were added» gives way to the warning.
  assert.match(slot, /const noticeIsOnlyImported = notice !== "" && notice\.split\(t\.imported\)\.every\(\(part\) => part\.trim\(\) === ""\);/);
  assert.match(slot, /const messageText = error \|\| \(heavyImportText && noticeIsOnlyImported \? "" : notice\);/);
  // The outdated-result banner depends on the message slot and the slicing
  // state only — never on the warning, which rides in its text instead.
  assert.match(slot, /const staleBannerShown = currentStale && !messageText && status !== "slicing";/);
  assert.match(slot, /const heavyWarningShown = Boolean\(heavyImportText\) && !messageText && !staleBannerShown;/);
  assert.match(client, /\{staleBannerShown && <div className="stale-banner" role="status">\s*<Icon name="warning" \/><span>\{heavyImportText \? `\$\{t\.staleHelp\} \$\{heavyImportText\}` : t\.staleHelp\}<\/span>/);
  assert.match(client, /\{heavyWarningShown && <div className="editor-message notice" role="status" data-levo-warning="heavy-import">/);
  // A finished slice ends the warning.
  const sliced = client.slice(client.indexOf("const handleSliced = useCallback("), client.indexOf("const handleSliced = useCallback(") + 400);
  assert.match(sliced, /setHeavyImportTriangles\(null\);/);

  // The precedence itself, evaluated with the same expressions.
  const imported = "Files were added to the project.";
  const decide = ({ error = "", notice = "", heavy = "", stale = false, slicing = false }) => {
    const noticeIsOnlyImported = notice !== "" && notice.split(imported).every((part) => part.trim() === "");
    const messageText = error || (heavy && noticeIsOnlyImported ? "" : notice);
    const staleBannerShown = stale && !messageText && !slicing;
    const heavyWarningShown = Boolean(heavy) && !messageText && !staleBannerShown;
    return { messageText, staleBannerShown, heavyWarningShown };
  };
  const heavy = "108,300 triangles — slicing this model may take a while.";
  assert.deepEqual(decide({ notice: imported, heavy }), { messageText: "", staleBannerShown: false, heavyWarningShown: true });
  assert.deepEqual(decide({ notice: `${imported} ${imported}`, heavy }), { messageText: "", staleBannerShown: false, heavyWarningShown: true });
  assert.equal(decide({ notice: "Arranged 3 models on 2 plates.", heavy }).messageText, "Arranged 3 models on 2 plates.");
  assert.deepEqual(decide({ heavy, stale: true }), { messageText: "", staleBannerShown: true, heavyWarningShown: false });
  assert.deepEqual(decide({ stale: true }), { messageText: "", staleBannerShown: true, heavyWarningShown: false });
  assert.equal(decide({ error: "boom", heavy, stale: true }).messageText, "boom");
  assert.deepEqual(decide({ heavy, stale: true, slicing: true }), { messageText: "", staleBannerShown: false, heavyWarningShown: true });
});

test("an EMPTY engine error is a clear: it never sets the error status over a slice in progress", async () => {
  const client = await read("../app/slicer-client.tsx");
  const at = client.indexOf('} else if (event.type === "error") {');
  const branch = client.slice(at, client.indexOf("// eslint-disable-next-line react-hooks/exhaustive-deps", at));
  const empty = branch.slice(branch.indexOf("if (!event.value) {"), branch.indexOf("return;", branch.indexOf("if (!event.value) {")));
  assert.ok(empty.length > 0, "the empty value is handled first");
  assert.match(empty, /setError\(""\);/);
  assert.match(empty, /setDowngradeOfferFor\(null\);/);
  assert.match(empty, /setStatus\(\(current\) => current === "error" \? "editing" : current\);/);
  assert.doesNotMatch(empty, /setStatus\("error"\)|endImportWait/);
  // A real error still ends the import wait and shows the error status.
  const real = branch.slice(branch.indexOf("return;"));
  assert.match(real, /endImportWait\(\);[\s\S]*setError\(event\.value\);[\s\S]*setStatus\("error"\);/);
});

test("the Editor mode choice is the first thing in Settings, above the printer", async () => {
  const setup = await read("../app/components/sheets/setup.tsx");
  const body = setup.indexOf('<div className="sheet-body setup-body">');
  const modeAt = setup.indexOf('<fieldset className="mode-fieldset">');
  const firstFieldset = setup.indexOf("<fieldset", body);
  assert.ok(body > 0 && modeAt > 0);
  assert.equal(firstFieldset, modeAt, "the mode fieldset opens the sheet");
  assert.ok(modeAt < setup.indexOf("<legend>{t.printer}</legend>"));
  // "All settings" still switches to Advanced from Simple.
  assert.match(setup, /props\.mode === "simple" \? t\.modeSwitchHelp : t\.advancedHelp/);
});

test("Simple keeps a way to slice and to print at every width", async () => {
  const [client, header, css] = await Promise.all([
    read("../app/slicer-client.tsx"),
    read("../app/components/header.tsx"),
    read("../app/globals.css"),
  ]);
  // Desktop: the header carries the slice action in Simple (the panel that
  // has it in Advanced is hidden), the print action once a result is ready.
  assert.match(header, /props\.simpleMode && !props\.printReady && \(/);
  assert.match(header, /onClick=\{props\.sliceAction\.onClick\}/);
  assert.match(client, /onClick: primaryAction,/);
  // Phone: the bar's primary action is mode-independent, and Settings opens
  // the Setup sheet in Simple instead of a panel that does not exist there.
  assert.match(client, /className=\{`mobile-primary-action/);
  assert.match(client, /if \(simpleMode\) setSheet\("setup"\);/);
  // The header slice button is desktop-only; the phone bar has its own.
  assert.match(css, /\.studio-actions \.header-slice-action \{ display: none; \}|\.studio-actions \.header-slice-action\s*\{\s*display:\s*none/);
  // In Simple "all settings" switches to Advanced instead of opening nothing.
  assert.match(client, /if \(simpleMode\) studioMode\.setMode\("advanced"\);/);
});

test("the mode strings exist in ar, en and real Sorani (never a copy of the Arabic)", async () => {
  const keys = ["modeTitle", "modeSimple", "modeSimpleShort", "modeAdvanced", "modeAdvancedShort", "modeSimpleHelp", "modeAdvancedHelp", "modeSwitchHelp",
    "certTrustPrompt", "certFileUnavailable", "certTrustCancelled", "lanAddressInvalid", "lanAccessCodeInvalid", "lanSerialRequired"];
  const [en, ar, ckb] = await Promise.all(["en", "ar", "ckb"].map((l) => read(`../app/i18n/${l}.ts`)));
  const value = (src, key) => new RegExp(`\\n  ${key}: "((?:[^"\\\\]|\\\\.)*)"`).exec(src)?.[1];
  for (const key of keys) {
    const [e, a, k] = [value(en, key), value(ar, key), value(ckb, key)];
    assert.ok(e && a && k, `${key} must exist in all three`);
    assert.notEqual(k, a, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    if (!/^[A-Za-z]/.test(k)) assert.notEqual(k, e, `${key}: ckb must be translated`);
  }
  // The trust prompt keeps its placeholder in every language.
  for (const src of [en, ar, ckb]) assert.match(value(src, "certTrustPrompt"), /\{fingerprints\}/);
  // The rate-limit message in the projects panel too.
  const panel = await read("../app/components/projects-panel.tsx");
  assert.equal((panel.match(/\n {4}rateLimited: "/g) || []).length, 3);
});

test("the certificate-trust prompt is built in the reader's language, fingerprints and ports untouched", async () => {
  const { loadAppModule } = await import("./lib/load-app-module.mjs");
  const bridge = await loadAppModule("native-printer-bridge");
  const copy = {
    trustPrompt: "تحقق:\n\n{fingerprints}\n\nتابع فقط إذا تطابقت.",
    fileUnavailable: "غير متاح (اتصال للحالة فقط)",
  };
  const both = bridge.certificateTrustMessage(copy, "a1b2c3d4", "0011ff");
  assert.equal(both, "تحقق:\n\nMQTT 8883:\na1:b2:c3:d4\n\nFTPS 990:\n00:11:ff\n\nتابع فقط إذا تطابقت.");
  const statusOnly = bridge.certificateTrustMessage(copy, "a1b2", null);
  assert.match(statusOnly, /FTPS 990: غير متاح \(اتصال للحالة فقط\)/);
  // No English prompt is left in the bridge itself.
  const source = await read("../app/native-printer-bridge.ts");
  assert.doesNotMatch(source, /window\.confirm\(`Verify/);
  assert.doesNotMatch(source, /new Error\("(Printer certificate|Enter a private|The printer access code|Enter the printer serial)/);
});

test("a choice the server did not take is never reverted, and a load in flight never undoes a newer click", async () => {
  const storage = memoryStorage();
  mode.setModeStorageForTests(storage);
  try {
    // (1) The account stored Simple earlier; switching to Advanced fails
    //     (offline / 429 / 5xx). The next load must push Advanced, not
    //     restore Simple over it.
    const ns = namespaceForUser("usr_flaky");
    const api = fakeApi({ stored: "simple" });
    assert.equal(await mode.loadStudioMode({ namespace: ns, signedIn: true, api }), "simple");
    assert.equal(mode.isModeMirrorPending(ns), false, "a value the server confirmed is not pending");
    const down = fakeApi({ stored: "simple", fail: true });
    assert.equal(await mode.saveStudioMode({ namespace: ns, signedIn: true, api: down, mode: "advanced" }), false);
    assert.equal(mode.isModeMirrorPending(ns), true, "the unsent choice is marked pending");
    api.calls.length = 0;
    assert.equal(await mode.loadStudioMode({ namespace: ns, signedIn: true, api }), "advanced", "the last click stands");
    assert.deepEqual(api.calls, [["GET"], ["PUT", "advanced"]]);
    assert.equal(api.row, "advanced");
    assert.equal(mode.readModeMirror(ns), "advanced");
    assert.equal(mode.isModeMirrorPending(ns), false, "confirmed once the PUT succeeded");
    // A later load with the server's stored value changes nothing.
    assert.equal(await mode.loadStudioMode({ namespace: ns, signedIn: true, api }), "advanced");

    // Back online: a pending choice goes up without waiting for a reload.
    const ns2 = namespaceForUser("usr_reconnect");
    await mode.saveStudioMode({ namespace: ns2, signedIn: true, api: fakeApi({ fail: true }), mode: "advanced" });
    const online = fakeApi({ stored: "simple" });
    assert.equal(await mode.pushPendingMode({ namespace: ns2, signedIn: true, api: online }), true);
    assert.equal(online.row, "advanced");
    assert.equal(mode.isModeMirrorPending(ns2), false);
    assert.equal(await mode.pushPendingMode({ namespace: ns2, signedIn: true, api: online }), false, "nothing left to send");

    // (2) The mirror holds an unsent Advanced; the person picks Simple while
    //     the initial GET is still in flight. The load must neither rewrite
    //     the mirror nor push its stale Advanced after the person's Simple.
    const ns3 = namespaceForUser("usr_race");
    await mode.saveStudioMode({ namespace: ns3, signedIn: true, api: fakeApi({ fail: true }), mode: "advanced" });
    let row = null;
    const order = [];
    let releaseGet;
    const slow = {
      get() {
        order.push("GET");
        const answer = { mode: row ?? "simple", stored: row !== null };
        return new Promise((resolve) => (releaseGet = () => resolve(answer)));
      },
      async put(next) {
        order.push(`PUT ${next}`);
        row = next;
        return { mode: row, stored: true };
      },
    };
    let choice = 0;
    const loading = mode.loadStudioMode({
      namespace: ns3,
      signedIn: true,
      api: slow,
      stillCurrent: () => choice === 0,
    });
    await Promise.resolve();
    choice += 1; // what use-studio-mode's setMode does before saving
    assert.equal(await mode.saveStudioMode({ namespace: ns3, signedIn: true, api: slow, mode: "simple" }), true);
    releaseGet();
    assert.equal(await loading, "simple");
    assert.deepEqual(order, ["GET", "PUT simple"], "the stale load pushed nothing");
    assert.equal(row, "simple", "the server keeps the person's click");
    assert.equal(mode.readModeMirror(ns3), "simple");
    assert.equal(mode.isModeMirrorPending(ns3), false);

    // The hook wires both halves: stillCurrent from its choice counter, and
    // a re-send when the browser comes back online.
    const hookSource = await read("../app/hooks/use-studio-mode.ts");
    assert.match(hookSource, /stillCurrent:\s*\(\)\s*=>\s*active && choiceRef\.current === choiceAtStart/);
    assert.match(hookSource, /addEventListener\("online"/);
    assert.match(hookSource, /pushPendingMode\(/);

    // The sign-out purge forgets the pending mark too.
    mode.clearModeMirror(ns2);
    await mode.saveStudioMode({ namespace: ns2, signedIn: true, api: fakeApi({ fail: true }), mode: "simple" });
    mode.clearModeMirror(ns2);
    assert.ok(![...storage.map.keys()].some((k) => k.includes("usr_reconnect")));
  } finally {
    mode.setModeStorageForTests(null);
  }
});
