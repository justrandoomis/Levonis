/**
 * THE EDITOR WENT STICKY, AND THE ENGINE'S TREE WAS BEING REBUILT SIX TIMES A
 * SECOND TO DO IT.
 *
 * «ما زال التقطيع وlagging موجود» — slicing still lags. `Viewport` is
 * three-slicer's default export and it is a PLAIN function component. React
 * re-renders a plain child on every parent render whether or not its props
 * changed, and the tree behind this one is the gizmo rail, the object list,
 * the plate bar, the stats card, the slice bar and three `SettingsBook`s
 * carrying the kernel's whole option surface.
 *
 * `SlicerClient` re-renders constantly and for reasons that have nothing to do
 * with any of that: slice progress alone is ~6 renders a second
 * (PROGRESS_THROTTLE_MS is 160 ms in hooks/use-slicing-state.ts), plus every
 * notice, status label, sheet and tool-tray toggle. On a desktop the
 * reconciliation is invisible. On a phone it runs on the same main thread that
 * has to service the engine's worker replies, while the kernel has the CPU.
 *
 * Hoisting the props to module constants (EXTRUDER_COLORS and friends) was the
 * previous round of this and could not finish the job, because identical props
 * do not stop a plain component re-rendering — only an identical ELEMENT does.
 * So the element is cached, and this file guards the two ways that cache can
 * go wrong:
 *
 *   IT STOPS WORKING — something renders `<Viewport>` inline again, or the
 *   memo grows a dependency that changes every render, and the lag is back
 *   with nothing visibly different.
 *
 *   IT WORKS TOO WELL — a prop is added to the JSX and not to the dependency
 *   list, so the engine silently keeps being handed the OLD one. That is the
 *   worse failure: it looks like the settings bug this same round just fixed.
 *
 * The check is structural rather than textual: the props and the dependency
 * list are both read out of the syntax tree and compared.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const clientUrl = new URL("../app/slicer-client.tsx", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);

const source = await readFile(clientUrl, "utf8");
const file = ts.createSourceFile("slicer-client.tsx", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

/** The `const viewportElement = useMemo(<fn>, [<deps>])` declaration. */
function findViewportMemo() {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "viewportElement"
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === "useMemo"
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** The `<Viewport …/>` element inside a subtree, with its attributes. */
function findViewportJsx(root) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (opening && ts.isIdentifier(opening.tagName) && opening.tagName.text === "Viewport") {
      found = opening;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Every free name an expression reads, reduced to its ROOT.
 *
 * `device.memoryConstrained` counts as `device`, because that is what a
 * dependency list names and what React compares. Property names, JSX
 * attribute names and object literal keys are not reads and are skipped.
 */
function rootsRead(node) {
  const roots = new Set();
  const visit = (current) => {
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression); // the object is read; `.name` is not
      return;
    }
    if (ts.isIdentifier(current)) {
      roots.add(current.text);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return roots;
}

const memo = findViewportMemo();

test("the engine's Viewport is a plain component — which is why the element is cached", async () => {
  // The engine fact the whole file rests on, pinned the way
  // studio-regressions.test.mjs pins engine facts: if a later three-slicer
  // wraps its export in memo(), this guard should be RECONSIDERED, not kept
  // out of habit.
  const engine = await readFile(engineUrl, "utf8");
  const exportLine = /export \{\s*(\w+) as default\s*\}/.exec(engine);
  assert.ok(exportLine, "three-slicer must still have a named default export");
  const component = exportLine[1];
  assert.match(
    engine,
    new RegExp(`function ${component}\\(`),
    `${component} is exported as default and must still be a plain function, not a memo() result`
  );
});

test("the Viewport element is built once and cached — never inline in the render", () => {
  assert.ok(memo, "viewportElement must be a useMemo — an inline element defeats the whole thing");
  const occurrences = (source.match(/<Viewport\b/g) ?? []).length;
  assert.equal(occurrences, 1, "there must be exactly one <Viewport>, and it must be the memoized one");
  assert.ok(findViewportJsx(memo.arguments[0]), "the single <Viewport> must be the one inside the memo");
  // And it is what the render puts on the page.
  assert.match(source, /\{viewportElement \?\? \(/, "the render must use the cached element");
});

test("EVERY prop the engine is handed is in the dependency list", () => {
  /**
   * The failure this exists for is silent. Add a prop, forget the dep, and the
   * engine keeps the value it was given on the render the element was built —
   * forever. There is no error and nothing looks stale; the control simply
   * stops working, which is precisely the bug (`machine-lock.ts`) this same
   * round of work was opened to fix.
   */
  const jsx = findViewportJsx(memo.arguments[0]);
  const deps = memo.arguments[1];
  assert.ok(deps && ts.isArrayLiteralExpression(deps), "the memo must declare a dependency array");

  const declared = new Set();
  for (const entry of deps.elements) for (const root of rootsRead(entry)) declared.add(root);

  /**
   * Module-level constants, which cannot change between renders. They are
   * listed by name rather than inferred, so that hoisting something to module
   * scope stays a decision somebody made: a value that is NOT actually
   * constant would otherwise get a free pass here.
   */
  const moduleConstants = new Set([
    "EDITOR_PANELS",
    "EDITOR_FEATURES_COLD",
    "EDITOR_FEATURES_WARM",
    "EXTRUDER_COLORS",
  ]);
  for (const name of moduleConstants) {
    assert.match(
      source,
      new RegExp(`^const ${name} = `, "m"),
      `${name} is treated as a constant here, so it must be declared at module scope`
    );
  }

  const passed = [];
  for (const attribute of jsx.attributes.properties) {
    assert.ok(ts.isJsxAttribute(attribute), "a spread onto Viewport would hide its props from this check");
    const name = attribute.name.getText(file);
    if (name === "key") continue; // React's own, never a prop the engine reads
    const initializer = attribute.initializer;
    assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression, `${name} has no expression`);
    passed.push(name);
    for (const root of rootsRead(initializer.expression)) {
      if (moduleConstants.has(root)) continue;
      assert.ok(
        declared.has(root),
        `<Viewport ${name}={…}> reads "${root}", which is not in the memo's dependency list. `
          + `The engine would keep the value from the render this element was built on.`
      );
    }
  }

  // The engine really is being given the props the shell thinks it is.
  for (const required of ["settings", "setSettings", "onEvent", "onSliced", "panels"]) {
    assert.ok(passed.includes(required), `the engine must still be handed ${required}`);
  }
});

test("the cache is not defeated by a dependency that changes every render", () => {
  /**
   * A memo whose deps are rebuilt on each render is a memo that never hits,
   * and it looks exactly like one that does. Object, array and arrow literals
   * are new identities every time, so none of them may appear in this list.
   */
  const deps = memo.arguments[1];
  for (const entry of deps.elements) {
    const kind = ts.isObjectLiteralExpression(entry) ? "an object literal"
      : ts.isArrayLiteralExpression(entry) ? "an array literal"
        : ts.isArrowFunction(entry) || ts.isFunctionExpression(entry) ? "a function literal"
          : ts.isCallExpression(entry) ? "a call"
            : null;
    assert.equal(
      kind,
      null,
      `the dependency \`${entry.getText(file)}\` is ${kind} — a fresh identity every render, so the memo never hits`
    );
  }
});
