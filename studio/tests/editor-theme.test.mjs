/**
 * The editor theme must PARSE, and the engine's wordmark must stay hidden.
 *
 * WHY BOTH. On 2026-08-30 a backtick inside a prose comment — a comment that
 * sits INSIDE the EDITOR_SHADOW_CSS template literal — closed the string and
 * made the whole Studio unbuildable. The owner reported the Studio unchanged;
 * nothing had shipped because nothing could build, and the only trace was in
 * the server pass of a deploy log nobody read.
 *
 * So there are two separate failures worth catching, and one test each:
 *
 *   1. The file no longer parses. Cheap to introduce (one backtick, one "${"
 *      in ordinary prose) and invisible until a build runs.
 *   2. The file parses fine but the rule that hides the vendored "ThreeSlicer
 *      RE" wordmark is gone — a refactor drops a line, the build stays green,
 *      and a foreign product name reappears on the owner's page.
 *
 * The first test would have caught the real incident. The second guards the
 * behaviour the first cannot see.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadAppModule } from "./lib/load-app-module.mjs";

const themeUrl = new URL("../app/editor-theme.ts", import.meta.url);

test("editor-theme.ts parses — no stray backtick or interpolation in the CSS", async () => {
  const source = await readFile(themeUrl, "utf8");
  const parsed = ts.createSourceFile(
    "editor-theme.ts",
    source,
    ts.ScriptTarget.ES2020,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
  // `parseDiagnostics` is internal but stable, and it is the only way to see
  // syntax errors without spinning up a full Program (which would need the
  // whole dependency graph resolved just to notice an unterminated string).
  const errors = (parsed.parseDiagnostics ?? []).map((d) => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(d.start ?? 0);
    return `${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
  assert.deepEqual(
    errors,
    [],
    `app/editor-theme.ts has syntax errors — the Studio cannot build:\n  ${errors.join("\n  ")}`
  );
});

test("the vendored engine wordmark stays hidden", async () => {
  const source = await readFile(themeUrl, "utf8");
  // Match the rule, not its formatting: any whitespace, and the !important is
  // required because the engine ships its own .tb-logo rule inside the same
  // shadow root and would otherwise win on order.
  const rule = /\.tb-logo\s*\{[^}]*display:\s*none\s*!important[^}]*\}/;
  assert.match(
    source,
    rule,
    'EDITOR_SHADOW_CSS must hide .tb-logo with !important — without it the ' +
      'engine\'s "ThreeSlicer RE" wordmark reappears in the Studio top bar, ' +
      "linking away from the editor."
  );
});

test("a read-only engine card keeps its labels readable in both themes", async () => {
  const source = await readFile(themeUrl, "utf8");
  // The engine dims a read-only panel (the printer card, with the motion
  // limits in it) by putting opacity .62 on its wrapper, which took the
  // labels to 2.6:1 on the light cards. The wrapper goes back to full
  // strength; only the inactive controls inside stay dimmed.
  assert.match(source, /\.vp-readonly \{ opacity: 1 !important; \}/);
  assert.match(source, /\.vp-readonly :is\(input, select, textarea, button:not\(\.lbl\)\) \{ opacity: \.62; \}/);
  const { STUDIO_SURFACES, STUDIO_SURFACES_LIGHT } = await loadAppModule("editor-theme");
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // What a .62 wrapper did to the muted label on the light card: blend, then measure.
  const blend = (fg, bg, alpha) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
  assert.ok(contrast(blend(STUDIO_SURFACES_LIGHT.muted, STUDIO_SURFACES_LIGHT.surface, 0.62), STUDIO_SURFACES_LIGHT.surface) < 4.5, "the finding, reproduced from the tokens");
  for (const [name, surfaces] of [["dark", STUDIO_SURFACES], ["light", STUDIO_SURFACES_LIGHT]]) {
    for (const bg of ["panel", "surface"]) {
      for (const fg of ["muted", "text", "goldText"]) {
        const ratio = contrast(surfaces[fg], surfaces[bg]);
        assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 at full strength`);
      }
    }
  }
});

test("the engine greys read on both ladders, in every nested panel", async () => {
  // c6-r2-ha-03: the vendored panels write their quiet text in fixed greys,
  // and only the main engine host took the light theme, so a nested panel
  // (All settings, Motion) stayed on the dark ladder inside a cream sidebar.
  const { EDITOR_SHADOW_CSS, STUDIO_SURFACES: dark, STUDIO_SURFACES_LIGHT: light } = await loadAppModule("editor-theme");
  assert.ok(EDITOR_SHADOW_CSS.includes(".settings-panel .unit, .settings-panel .pts, .purge-grid th, .bp-note, .muted { color: var(--lv-muted) !important; }"));
  assert.ok(EDITOR_SHADOW_CSS.includes(".sc-dirty { color: var(--lv-warning) !important; }"));
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // The reviewer's measurements, reproduced from the engine's own colours.
  assert.equal(contrast("#888888", dark.panel).toFixed(2), "4.25", "the unit on the dark panel");
  assert.equal(contrast("#AEBCC6", light.panel).toFixed(2), "1.54", "T1 on the light panel");
  assert.equal(contrast("#8B98A2", light.panel).toFixed(2), "2.33", "the bed note on the light panel");
  assert.equal(contrast("#C47F00", light.surface).toFixed(2), "2.75", "Modified on the light card");
  // The token pairs that replace them clear 4.5:1 on every surface they sit on.
  const pairs = [
    ["muted on the dark panel", dark.muted, dark.panel, "5.80"],
    ["muted on the light panel", light.muted, light.panel, "5.30"],
    ["warning on the light card", light.warning, light.surface, "5.41"],
  ];
  for (const [name, fg, bg, ratio] of pairs) assert.equal(contrast(fg, bg).toFixed(2), ratio, name);
  for (const [name, surfaces] of [["dark", dark], ["light", light]]) {
    for (const bg of ["panel", "surface", "shell"]) {
      for (const fg of ["muted", "warning"]) {
        const ratio = contrast(surfaces[fg], surfaces[bg]);
        assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("every engine shadow host takes the theme, mode and viewport, nested ones included", async () => {
  const { EngineAdapter } = await loadAppModule("engine-adapter");
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  try {
    const host = () => {
      const attributes = new Map();
      return { isConnected: true, attributes, setAttribute: (name, value) => attributes.set(name, value), getAttribute: (name) => attributes.get(name) ?? null };
    };
    const root = (shell) => {
      const element = host();
      return {
        host: element,
        querySelector: (selector) => (shell && selector === ".app-shell" ? {} : null),
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
      };
    };
    const adapter = new EngineAdapter();
    const main = root(true);
    const nested = [root(false), root(false)];
    adapter.adoptRoot(main);
    for (const panel of nested) adapter.adoptRoot(panel);
    adapter.setHostAttribute("data-levo-theme", "light");
    adapter.setHostAttribute("data-levo-mode", "advanced");
    adapter.setHostAttribute("data-levo-viewport", "expanded");
    for (const [name, r] of [["main", main], ["nested 1", nested[0]], ["nested 2", nested[1]]]) {
      assert.equal(r.host.getAttribute("data-levo-theme"), "light", `${name} host`);
      assert.equal(r.host.getAttribute("data-levo-mode"), "advanced", `${name} host`);
      assert.equal(r.host.getAttribute("data-levo-viewport"), "expanded", `${name} host`);
    }
    // A panel that opens later (Motion, in All settings) takes them on adoption.
    const late = root(false);
    adapter.adoptRoot(late);
    assert.equal(late.host.getAttribute("data-levo-theme"), "light", "a host adopted after the flip");
    adapter.setHostAttribute("data-levo-theme", "dark");
    assert.equal(late.host.getAttribute("data-levo-theme"), "dark", "and follows the next flip");
  } finally {
    globalThis.MutationObserver = previous;
  }
});

test("the engine's own G-code links show only over a fresh result, at every width", async () => {
  // c6-r3-ha-02: on a phone, «كل الإعدادات» opens the engine panel, whose
  // «Export G-code» link stayed live after an edit and saved the G-code of
  // the old layer height while the shell said «نتيجة قديمة».
  const { EDITOR_SHADOW_CSS } = await loadAppModule("editor-theme");
  const gate = ':host(:not([data-levo-result="fresh"])) :is([data-testid="gcode-dl"], [data-testid="export-all"]) { display: none !important; }';
  assert.equal(EDITOR_SHADOW_CSS.split(gate).length - 1, 1, "the gate is in the shadow stylesheet once");
  // Outside every media query: the desktop panel obeys it too.
  assert.ok(EDITOR_SHADOW_CSS.indexOf(gate) < EDITOR_SHADOW_CSS.indexOf("@media"), "the gate applies at every width");
  // A host with no attribute yet (before the first render sets it) is gated.
  assert.match(gate, /^:host\(:not\(/);
  // The engine still names the two controls this way.
  const engine = await readFile(new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url), "utf8");
  assert.match(engine, /"a", \{ className: "export-btn", href: E, download: `plate_\$\{o \+ 1\}\.gcode`[^}]*"data-testid": "gcode-dl" \}/);
  assert.match(engine, /"data-testid": "export-all"/);
  // The shell says "fresh" exactly when its own export would allow G-code.
  const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  assert.match(client, /const printReady = status !== "slicing" && status !== "error" && currentResultState === "fresh";/);
  assert.match(client, /adapter\.setHostAttribute\("data-levo-result", printReady \? "fresh" : "not-fresh"\);\s*\}, \[adapter, printReady\]\);/);
  // The shell still reaches «export all» by a script click, which a hidden
  // control takes: clickControl checks only for a disabled button.
  const adapter = await readFile(new URL("../app/engine-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /clickControl\(testId: EngineTestId\): boolean \{\s*const element = this\.queryControl\(testId\);\s*if \(!element \|\| \(element instanceof HTMLButtonElement && element\.disabled\)\) return false;\s*element\.click\(\);/);
});

test("on a phone one finger orbits over the stats card and the bed warning too", async () => {
  // c6-r3-ha-03: a drag that started on the stats card (251 x 110 px of a
  // 356 x 303 canvas in preview) scrolled the page by 146 px and left the
  // view where it was.
  const { EDITOR_SHADOW_CSS } = await loadAppModule("editor-theme");
  const phone = EDITOR_SHADOW_CSS.slice(EDITOR_SHADOW_CSS.indexOf("@media (max-width: 899px) {"), EDITOR_SHADOW_CSS.indexOf("@media (min-width: 900px) {"));
  assert.ok(phone.length > 200, "the phone block is findable");
  assert.match(phone, /\.bed-warn, \.stats-card \{ pointer-events: none; \}/);
  // Neither holds a control a touch could have been meant for.
  const engine = await readFile(new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url), "utf8");
  const start = engine.indexOf("function yi(");
  const stats = engine.slice(start, engine.indexOf("\n}\n", start));
  assert.ok(stats.length > 200, "the stats card component is findable");
  assert.doesNotMatch(stats, /createElement\("(?:button|a|input|select|textarea|details|summary)"/, "the stats card has no control");
  const warn = engine.slice(engine.indexOf('className: "bed-warn"') - 40, engine.indexOf('"stats-card", "data-testid": "slice-stats"'));
  assert.doesNotMatch(warn, /onClick|createElement\("(?:button|a|input)"/, "the bed warning has no control");
});
