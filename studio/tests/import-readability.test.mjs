/**
 * «الملف فارغ» ON A FILE THAT IS NOT EMPTY, and a network error on a ZIP.
 *
 * Both reports are one wrong question, asked on the one device this shop is
 * actually run from.
 *
 * The importer used to decide emptiness from `File.size`. On an iPad, a file
 * picked out of iCloud Drive that has not been downloaded to the device yet is
 * handed to the page as a File whose `size` is 0. Nothing is wrong with it: it
 * is a real archive, one materialisation away. Calling it empty tells the
 * owner their file is broken when what it needs is to come down; and where the
 * read failed outright instead, the browser's own English sentence — «Load
 * failed» on Safari — was rendered verbatim into an Arabic right-to-left
 * interface, which is the network error that got reported.
 *
 * So emptiness is LOOKED AT now. One byte separates the three cases, and
 * asking for it is also what makes iOS materialise the file, so the common
 * case starts working rather than merely being described better.
 *
 * The third defect is inside the archive. The emptiness check runs on the
 * files the customer PICKED, and a ZIP is one file however many entries it
 * holds — so an empty `part.stl` inside it was never looked at, sailed past
 * `normalizeModelFile` (which only sniffs entries whose extension it does not
 * know), and reached the engine as an empty mesh.
 *
 * Run: node --test studio/tests/import-readability.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const orchestratorUrl = new URL("../app/import-orchestrator.ts", import.meta.url);
const orchestrator = await readFile(orchestratorUrl, "utf8");

/**
 * The module is transpiled and RUN rather than paraphrased — but importing it
 * whole would pull in the engine adapter, which a Node test has no business
 * loading. `ImportError` and `assertReadable` are pure and adjacent, so the
 * file is sliced to exactly them. The slice asserts it found both, which is
 * what stops this test passing against nothing after a rename.
 */
const from = orchestrator.indexOf("export class ImportError");
const to = orchestrator.indexOf("\nexport interface ImportContext");
assert.ok(from > 0, "ImportError is still exported from the orchestrator");
assert.ok(to > from, "assertReadable still sits between ImportError and ImportContext");
const slice = orchestrator.slice(from, to);
assert.match(slice, /export async function assertReadable/, "assertReadable is exported for this test");
const javascript = ts.transpileModule(slice, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ImportError, assertReadable } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

/** A File stand-in. `size` is stated separately from the bytes on purpose:
 *  that divergence IS the iPad case this file exists for. */
const fileLike = (name, { size, bytes, readThrows }) => ({
  name,
  size,
  slice: () => ({
    arrayBuffer: async () => {
      if (readThrows) throw new TypeError("Load failed");
      return new Uint8Array(bytes ?? []).buffer;
    },
  }),
});

const codeOf = async (file) => {
  try {
    await assertReadable(file);
    return null;
  } catch (reason) {
    assert.ok(reason instanceof ImportError, `expected an ImportError, got ${reason}`);
    return reason;
  }
};

test("a file that reads is accepted, whatever its size claims", async () => {
  assert.equal(await codeOf(fileLike("part.stl", { size: 1024, bytes: [0x73] })), null);
});

test("an iCloud file that has not come down yet is NOT called empty", async () => {
  // This is the exact shape iOS hands over: size 0, and a read that works
  // (and that is itself what triggers the download).
  const notDownloaded = fileLike("parts.zip", { size: 0, bytes: [0x50] });
  assert.equal(
    await codeOf(notDownloaded),
    null,
    "«الملف فارغ» on a real archive is the defect; one byte proves it is there"
  );
});

test("a file that really holds nothing is still called empty, and named", async () => {
  const refusal = await codeOf(fileLike("blank.stl", { size: 0, bytes: [] }));
  assert.equal(refusal.code, "empty-file");
  assert.equal(refusal.fileName, "blank.stl", "the owner has to know WHICH file");
});

test("a size that lies about being non-empty does not save it", async () => {
  // A stale handle can report bytes it no longer has. The read is what counts.
  const refusal = await codeOf(fileLike("stale.3mf", { size: 900_000, bytes: [] }));
  assert.equal(refusal.code, "empty-file");
});

test("a read that fails is neither empty nor an unrecognised format", async () => {
  const refusal = await codeOf(fileLike("offline.zip", { size: 400, readThrows: true }));
  assert.equal(
    refusal.code,
    "file-unreadable",
    "a disconnected drive or a revoked handle is its own answer, not a verdict on the file"
  );
  assert.equal(refusal.fileName, "offline.zip");
});

test("only one byte is read, so a 400 MB model is not read twice to prove it exists", async () => {
  let asked = null;
  await assertReadable({
    name: "huge.stl",
    size: 400 * 1024 * 1024,
    slice: (start, end) => {
      asked = [start, end];
      return { arrayBuffer: async () => new Uint8Array([1]).buffer };
    },
  });
  assert.deepEqual(asked, [0, 1]);
});

// ------------------------------------------------ the empty entry inside a ZIP

const archive = await readFile(new URL("../app/archive-import.ts", import.meta.url), "utf8");

test("a zero-byte entry inside a ZIP is dropped instead of loaded as a mesh", () => {
  // The guard must sit BEFORE the File is built: constructing it and then
  // deciding would already have handed `normalizeModelFile` something to wave
  // through on a known extension.
  const guard = archive.indexOf("if (!expandedSize) {");
  const build = archive.indexOf("const extracted = new File(");
  assert.ok(guard > 0, "the empty-entry guard is present");
  assert.ok(build > guard, "and it runs before the entry becomes a File");
  assert.match(archive, /emptyEntries \+= 1;/, "and the drop is counted, not silent");
  assert.match(archive, /emptyEntries\?: number;/, "the count is part of the progress contract");
});

test("an archive whose every model entry was empty does not blame the format", () => {
  const settle = archive.slice(archive.indexOf("const finish = () =>"));
  assert.match(
    settle.slice(0, 900),
    /emptyEntries[\s\S]{0,200}holds?" : "ies hold"/,
    "«does not contain a supported 3D model» is the wrong sentence when it contained models with no bytes in them"
  );
});

test("an extension-less entry that fails to sniff is dropped on purpose, and says why", () => {
  // README, LICENSE and thumbnail stubs ride in every model-site ZIP.
  // Refusing an archive over one — or reporting it as a lost model — would
  // both be wrong, so the catch is documented rather than left to look like
  // an oversight a later reader should "fix".
  const catchBlock = archive.slice(archive.indexOf("}).catch(() => {"));
  assert.match(catchBlock.slice(0, 900), /NOT A LOST MODEL/);
  assert.match(catchBlock.slice(0, 900), /LICENSE, README/);
});

// -------------------------------------------------------- what the screen says

const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");

test("the screen never shows the browser's own untranslated sentence", () => {
  const localize = client.slice(client.indexOf("const localizeImportError"));
  const body = localize.slice(0, localize.indexOf("}, [t.emptyFile"));
  assert.doesNotMatch(
    body,
    /return reason\.message/,
    "«Load failed» in an Arabic RTL interface is the network error that got reported"
  );
  assert.match(body, /console\.warn\("\[import\]", reason\)/, "the raw text still reaches the console");
  assert.match(body, /return t\.importFailed;/);
  assert.match(body, /reason\.code === "file-unreadable"/, "and the new code has a sentence of its own");
});

test("every import refusal the orchestrator can throw has a sentence in all three languages", async () => {
  const codes = orchestrator
    .slice(orchestrator.indexOf("export type ImportErrorCode"), orchestrator.indexOf("export const MODEL_FILE_BYTES_CEILING"))
    .match(/"[a-z-]+"/g)
    .map((quoted) => quoted.slice(1, -1));
  assert.ok(codes.includes("file-unreadable"), "the slice still finds the union");

  const localize = client.slice(client.indexOf("const localizeImportError"));
  const body = localize.slice(0, localize.indexOf("}, [t.emptyFile"));
  for (const code of codes) {
    // `unsupported-file`, `no-model-files` and `file-too-large` share the
    // generic sentence by design — the point is that NONE of them falls
    // through to a raw Error message.
    assert.ok(
      body.includes(`"${code}"`) || /return t\.importFailed;/.test(body),
      `${code} has no sentence`
    );
  }

  for (const locale of ["ar", "en", "ckb"]) {
    const table = await readFile(new URL(`../app/i18n/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["importFailed", "emptyFile", "engineUnavailable", "zipEntryLimit", "zipBudgetExceeded", "zipRatioLimit"]) {
      assert.match(table, new RegExp(`\\b${key}:`), `${locale} is missing ${key}`);
    }
  }
});
