/**
 * «لا تجعل هناك حد لرفع الملف ادعم الاحجام الكبيره مثل ١ كيكا و ٢ كيكا»
 * — and what a browser can actually do about that.
 *
 * THE ANSWER IS NO, AND THIS FILE IS WHY THE REFUSAL IS THE FEATURE.
 *
 * A browser cannot slice a one-gigabyte model, and nothing in this repository
 * changes that:
 *
 *   * the engine is wasm32 — its whole address space is 4 GiB, a property of
 *     the instruction set and not a setting;
 *   * iPad Safari, the device this shop is run from, kills a tab between 1 and
 *     1.5 GB of resident memory, long before that ceiling;
 *   * geometry does not stay the size of its file. MEASURED on this engine: a
 *     190.7 MB STL peaked at 1796 MB (9.42x) before the redundant copies were
 *     removed and 396 MB (2.08x) after; a 3MF is 57x, being compressed XML
 *     that becomes float32 vertices and int32 indices.
 *
 * So the owner chose to REFUSE above a ceiling rather than accept the file and
 * disable slicing afterwards: somebody who uploads 2 GB, waits, and is then
 * told it cannot be sliced has spent their time learning what we already knew.
 * The refusal is at SELECTION, before a byte is read.
 *
 * The one thing this must NOT do is measure an archive. A ZIP's danger is what
 * it EXPANDS to — `archive-import.ts` owns that with a budget, a confirmation
 * and a zip-bomb ratio test — and treating its compressed size as geometry
 * would refuse a legitimate 600 MB archive of small parts while waving through
 * a 40 MB one that expands to 3 GB.
 *
 * Run: node --test studio/tests/
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../app/import-orchestrator.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

/**
 * The module is transpiled and imported for real rather than paraphrased —
 * but it pulls in the engine adapter, which a Node test has no business
 * loading. Only the two exports under test are needed, and they are pure, so
 * the file is sliced to them. The slice is asserted to have found them, which
 * is what stops this test passing against nothing after a rename.
 */
const ceilingSource = source.slice(source.indexOf("export const MODEL_FILE_BYTES_CEILING"));
const cut = ceilingSource.indexOf("\nexport class ");
assert.ok(ceilingSource.startsWith("export const MODEL_FILE_BYTES_CEILING"), "the ceiling is still exported");
assert.ok(cut > 0, "the slice still ends at the orchestrator class");
const javascript = ts.transpileModule(ceilingSource.slice(0, cut), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { MODEL_FILE_BYTES_CEILING, oversizedModelFiles } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const MB = 1024 * 1024;
/** A File stand-in: the predicate reads `name` and `size` and nothing else. */
const file = (name, megabytes) => ({ name, size: Math.round(megabytes * MB) });

test("the ceiling is the measured one, not a round marketing number", () => {
  assert.equal(MODEL_FILE_BYTES_CEILING, 500 * MB);
  // 500 MB at the measured 2.08x working set is ~1.04 GB, which is the edge of
  // what an iPad tab survives beside the kernel and a rendered scene. A gigabyte
  // file would be 2 GB of geometry and is refused for that reason, not by taste.
  assert.ok(MODEL_FILE_BYTES_CEILING * 2.08 < 1.5 * 1024 * MB, "the working set stays inside the iPad tab budget");
});

test("a model at or under the ceiling is accepted", () => {
  assert.deepEqual(oversizedModelFiles([file("part.stl", 12)]), []);
  assert.deepEqual(oversizedModelFiles([file("big.stl", 500)]), [], "exactly the ceiling is allowed");
  assert.deepEqual(oversizedModelFiles([]), []);
});

test("a model over the ceiling is named", () => {
  const over = oversizedModelFiles([file("huge.stl", 900), file("ok.3mf", 20)]);
  assert.deepEqual(over.map((f) => f.name), ["huge.stl"]);
  // The 1 GB and 2 GB the owner asked about, specifically.
  assert.equal(oversizedModelFiles([file("a.stl", 1024)]).length, 1);
  assert.equal(oversizedModelFiles([file("b.3mf", 2048)]).length, 1);
});

test("a ZIP is never measured here — its danger is what it EXPANDS to", () => {
  assert.deepEqual(
    oversizedModelFiles([file("parts.zip", 600)]),
    [],
    "archive-import.ts owns the expansion budget, the confirmation and the ratio test"
  );
  assert.deepEqual(oversizedModelFiles([file("PARTS.ZIP", 900)]), [], "and the test is case-insensitive");
  // A .zip in the middle of a name is not an archive.
  assert.equal(oversizedModelFiles([file("my.zip.stl", 900)]).length, 1);
});

test("the ceiling is injectable, so a caller can be stricter without forking the rule", () => {
  assert.equal(oversizedModelFiles([file("m.stl", 60)], 50 * MB).length, 1);
  assert.equal(oversizedModelFiles([file("m.stl", 40)], 50 * MB).length, 0);
});

test("the refusal exists in all three languages and names the file and both numbers", async () => {
  for (const locale of ["ar", "en", "ckb"]) {
    const text = await readFile(new URL(`../app/i18n/${locale}.ts`, import.meta.url), "utf8");
    const line = text.split("\n").find((l) => l.trim().startsWith("fileTooLarge:"));
    assert.ok(line, `${locale} carries fileTooLarge`);
    for (const slot of ["{name}", "{size}", "{limit}"]) {
      assert.ok(line.includes(slot), `${locale} names ${slot} — a refusal with no numbers is a wall`);
    }
  }
});

test("it is refused at SELECTION, and the whole selection goes with it", async () => {
  const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const at = client.indexOf("const tooLarge = oversizedModelFiles(rawFiles);");
  assert.ok(at > 0, "the guard is in the import path");
  // Before the orchestrator is handed anything: no read, no wait, no progress
  // bar that ends in a failure.
  assert.ok(at < client.indexOf("orchestrator.importFiles("), "and before a byte is read");
  const body = client.slice(at, at + 900);
  assert.ok(body.includes("t.fileTooLarge"), "in the customer's own language");
  assert.ok(body.includes("return;"), "and nothing is imported");
  // Not a silent drop of the oversized member: a ZIP of parts plus one
  // enormous STL is one intent, and importing "most of it" without saying so
  // is quiet data loss.
  assert.ok(!/tooLarge[\s\S]{0,200}filter\(/.test(body), "the selection is refused, not trimmed");
});

test("the loading readout counts 1 to 100 and never reaches 100 early", async () => {
  const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  assert.ok(client.includes("import-progress-percent"), "«تحميل من ١ ل١٠٠» has a readout, not just a bar");
  // Floored and clamped: 99.7% must not read «100» while the file is still
  // being parsed — the hundred belongs to the finished import, which is the
  // moment the whole row disappears.
  assert.match(client, /Math\.min\(99, Math\.max\(1, Math\.floor\(/);
  // Latin digits, left-to-right, so «100%» does not reorder in an Arabic layout.
  assert.match(client, /<span className="import-progress-percent" dir="ltr">/);
});
