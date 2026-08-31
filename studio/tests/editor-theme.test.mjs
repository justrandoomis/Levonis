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
