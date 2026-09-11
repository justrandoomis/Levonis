/**
 * Import an `app/*.ts` module in a plain Node test.
 *
 * The existing tests transpile a single file into a data: URL, which works
 * only while that file imports nothing local. `engine-adapter.ts` imports
 * `plate-packing` and `spawn-seating`, so it needs the graph. This walks the
 * relative imports, transpiles each file once, and writes the results into a
 * gitignored build directory where Node's own resolver can follow them.
 *
 * Type-only imports disappear in transpilation, so only real value imports
 * are followed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const appDir = fileURLToPath(new URL("../../app/", import.meta.url));
const outDir = fileURLToPath(new URL("../../node_modules/.levo-test-build/", import.meta.url));

const built = new Set();

async function build(absTsPath) {
  if (built.has(absTsPath)) return;
  built.add(absTsPath);

  const source = await readFile(absTsPath, "utf8");
  let js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve },
    fileName: absTsPath,
  }).outputText;

  const deps = [];
  js = js.replace(/(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\2/g, (_m, head, quote, spec) => {
    deps.push(spec);
    return `${head}${quote}${spec}.ts.mjs${quote}`;
  });

  const outPath = resolve(outDir, relative(appDir, absTsPath).replace(/\.tsx?$/, ".ts.mjs"));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, js, "utf8");

  for (const spec of deps) {
    const depTs = resolve(dirname(absTsPath), `${spec}.ts`);
    try {
      await readFile(depTs, "utf8");
      await build(depTs);
    } catch {
      // .tsx or a type-only path that produced no file — try .tsx, else skip.
      const depTsx = resolve(dirname(absTsPath), `${spec}.tsx`);
      try { await readFile(depTsx, "utf8"); await build(depTsx); } catch { /* not a local module */ }
    }
  }
}

/** `loadAppModule("engine-adapter")` -> the module's live exports. */
export async function loadAppModule(name) {
  const abs = resolve(appDir, `${name}.ts`);
  await build(abs);
  const outPath = resolve(outDir, `${name}.ts.mjs`);
  return import(`${pathToFileURL(outPath).href}?t=${built.size}`);
}
