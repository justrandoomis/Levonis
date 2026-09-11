/**
 * Run a callback that lives inside a React component, without React.
 *
 * WHY THIS EXISTS. Several of the guards this repo depends on are decisions
 * taken inside `app/slicer-client.tsx` — whether a batch of new object ids is
 * a spawn or a restore, whether letting the slice worker go is safe, whether
 * the autosave fingerprint can be trusted. They are the difference between a
 * user keeping their layout and their brush strokes and losing both, and the
 * previous round of this work shipped five regressions in exactly that logic.
 *
 * Asserting on the SOURCE TEXT of those guards is worth very little: it pins
 * the spelling, not the behaviour, and it passes happily while the logic is
 * wrong. So these tests execute the real thing. The component's callbacks are
 * lifted out of the file by the TypeScript compiler's own parser, transpiled,
 * and called with stand-ins for everything they close over. If someone edits
 * the guard, the edited guard is what runs here.
 *
 * The one thing this cannot do is React: hooks are not called, effects do not
 * run, and state does not update. Every callback covered here is pure with
 * respect to that — it reads refs and props and returns a decision — which is
 * why lifting it out is faithful rather than a re-implementation.
 */
import { readFile } from "node:fs/promises";
import ts from "typescript";

const clientUrl = new URL("../../app/slicer-client.tsx", import.meta.url);

let cachedSource = null;
async function source() {
  if (cachedSource === null) cachedSource = await readFile(clientUrl, "utf8");
  return cachedSource;
}

/**
 * Finds `const <name> = useCallback(<fn>, [...])` (or a plain
 * `const <name> = <fn>`) at any depth and returns the function's source text.
 */
function findCallback(file, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
    ) {
      let fn = node.initializer;
      if (
        ts.isCallExpression(fn)
        && ts.isIdentifier(fn.expression)
        && (fn.expression.text === "useCallback" || fn.expression.text === "useMemo")
      ) {
        fn = fn.arguments[0];
      }
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        found = fn.getText(file);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every identifier the function reads but does not itself declare — the
 * closure it needs. Collected from the AST rather than by guessing, so a
 * callback that starts using something new fails loudly (an undefined stub)
 * instead of silently reading a global.
 */
function freeIdentifiers(fnText) {
  const file = ts.createSourceFile("fn.tsx", `const __f = ${fnText}`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declared = new Set(["__f"]);
  const used = new Set();

  const declare = (nameNode) => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode)) declared.add(nameNode.text);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) if (ts.isBindingElement(el)) declare(el.name);
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) declare(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    // Property names in `a.b` and `{ b: 1 }` are not free variables.
    if (ts.isPropertyAccessExpression(node)) { visit(node.expression); return; }
    if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) { visit(node.initializer); return; }
    if (ts.isIdentifier(node) && node.text !== "undefined") used.add(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return [...used].filter((name) => !declared.has(name) && !(name in globalThis));
}

/**
 * Lifts one callback out of slicer-client.tsx and returns a factory: give it
 * the closure values you care about and it returns the real function. Any
 * closure name you do not supply becomes a throwing stub, so a test can never
 * pass by accident because the callback quietly used something unstubbed.
 */
export async function liftCallback(name) {
  const text = await source();
  const file = ts.createSourceFile("slicer-client.tsx", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const fnText = findCallback(file, name);
  if (!fnText) throw new Error(`callback ${name} not found in app/slicer-client.tsx`);

  const names = freeIdentifiers(fnText);
  const js = ts.transpileModule(`const __fn = ${fnText};`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve },
    fileName: "fn.tsx",
  }).outputText;

  return (closure = {}) => {
    const args = names.map((key) => {
      if (key in closure) return closure[key];
      return new Proxy(() => {}, {
        get: () => { throw new Error(`callback ${name} read un-stubbed closure value "${key}"`); },
        apply: () => { throw new Error(`callback ${name} called un-stubbed closure value "${key}"`); },
      });
    });
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `${js}\nreturn __fn;`);
    return factory(...args);
  };
}

/** The names a lifted callback closes over — useful for asserting coverage. */
export async function closureOf(name) {
  const text = await source();
  const file = ts.createSourceFile("slicer-client.tsx", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const fnText = findCallback(file, name);
  if (!fnText) throw new Error(`callback ${name} not found in app/slicer-client.tsx`);
  return freeIdentifiers(fnText);
}

/** A mutable React-style ref, for stubbing the component's own refs. */
export const ref = (current) => ({ current });
