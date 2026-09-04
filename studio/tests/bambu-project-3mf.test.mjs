/**
 * THE PROJECT FILE THE OWNER UPLOADS.
 *
 * The fixture below is shaped exactly like what the installed engine writes —
 * same entry names, the same `<model>` header carrying
 * `Application = ThreeSlicer`, the same `model_settings.config` grammar. That
 * shape was read out of node_modules/three-slicer/viewer/dist/Viewport.js for
 * this work. A fixture can drift from reality silently, so the first test
 * asserts the engine still writes what the fixture imitates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { loadAppModule } from "./lib/load-app-module.mjs";

const M = await loadAppModule("bambu-project-3mf");
const {
  toBambuProject, stampModelXml, stampProjectSettings, relsXml, contentTypesXml, sliceInfoXml, xmlEscape,
  MODEL_FILE, RELS_FILE, CONTENT_TYPES_FILE, PROJECT_SETTINGS_FILE, MODEL_SETTINGS_FILE,
  SLICE_INFO_FILE, PLATE_THUMBNAIL_FILE, PLATE_THUMBNAIL_SMALL_FILE,
} = M;

const OPTS = {
  projectName: "قاعدة الهاتف",
  application: "LEVO Studio-1.0.0",
  version: "1.0.0",
  createdAt: "2026-09-04",
  printerModelId: "C11",
  nozzleDiameters: "0.4",
};

const ENGINE_MODEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n' +
  ' <metadata name="Application">ThreeSlicer</metadata>\n' +
  " <resources>\n" +
  '  <object id="1" type="model">\n' +
  "   <mesh><vertices/><triangles/></mesh>\n" +
  "  </object>\n" +
  " </resources>\n <build>\n" +
  '  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n' +
  " </build>\n</model>\n";

const ENGINE_MODEL_SETTINGS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
  '  <object id="1">\n    <metadata key="name" value="tower"/>\n' +
  '    <metadata key="extruder" value="1"/>\n' +
  '    <volume firstid="0" lastid="11">\n      <metadata key="volume_type" value="ModelPart"/>\n    </volume>\n' +
  "  </object>\n</config>\n";

const ENGINE_PROJECT_SETTINGS =
  JSON.stringify({ layer_height: "0.2", wall_loops: "3", sparse_infill_density: "15%" }, null, 4) + "\n";

const engine3mf = (over = {}) =>
  zipSync({
    [RELS_FILE]: strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships/>'),
    [CONTENT_TYPES_FILE]: strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types/>'),
    [MODEL_FILE]: strToU8(ENGINE_MODEL_XML),
    [MODEL_SETTINGS_FILE]: strToU8(ENGINE_MODEL_SETTINGS),
    [PROJECT_SETTINGS_FILE]: strToU8(ENGINE_PROJECT_SETTINGS),
    ...over,
  });

const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(n).fill(1)]);

test("the fixture still matches what the engine actually writes", () => {
  const engine = readFileSync(
    new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url),
    "utf8"
  );
  for (const needle of [
    '"3D/3dmodel.model"',
    '"Metadata/model_settings.config"',
    '"Metadata/project_settings.config"',
    '"[Content_Types].xml"',
    '"_rels/.rels"',
    '<metadata name="Application">',
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"',
  ]) {
    assert.ok(engine.includes(needle), `engine no longer writes ${needle}`);
  }
});

test("the package gains every Bambu project entry", () => {
  const r = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(64), thumbnailSmallPng: png(16) });
  const out = unzipSync(r.bytes);
  for (const path of [
    MODEL_FILE, MODEL_SETTINGS_FILE, PROJECT_SETTINGS_FILE, SLICE_INFO_FILE,
    PLATE_THUMBNAIL_FILE, PLATE_THUMBNAIL_SMALL_FILE, RELS_FILE, CONTENT_TYPES_FILE,
  ]) {
    assert.ok(out[path], `${path} missing from the produced project`);
  }
});

test("the geometry is carried through, never re-serialized", () => {
  const src = engine3mf();
  const r = toBambuProject(src, { ...OPTS, thumbnailPng: png(8) });
  assert.equal(
    strFromU8(unzipSync(r.bytes)[MODEL_SETTINGS_FILE]),
    strFromU8(unzipSync(src)[MODEL_SETTINGS_FILE])
  );
  assert.ok(strFromU8(unzipSync(r.bytes)[MODEL_FILE]).includes("<mesh><vertices/><triangles/></mesh>"));
});

test("project_settings gets the header BambuStudio identifies it by", () => {
  const r = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8) });
  const cfg = JSON.parse(strFromU8(unzipSync(r.bytes)[PROJECT_SETTINGS_FILE]));
  assert.equal(cfg.name, "project_settings");
  assert.equal(cfg.from, "project");
  assert.equal(cfg.version, "1.0.0");
});

test("and every engine key survives untouched — the load is all-or-nothing", () => {
  // ConfigBase::load_from_json has no per-key recovery: one key BambuStudio
  // does not know throws and the WHOLE config is discarded. So this converter
  // may add keys and must never translate one.
  const r = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8) });
  const cfg = JSON.parse(strFromU8(unzipSync(r.bytes)[PROJECT_SETTINGS_FILE]));
  const original = JSON.parse(ENGINE_PROJECT_SETTINGS);
  for (const k of Object.keys(original)) assert.equal(cfg[k], original[k], `${k} was altered`);
  assert.deepEqual(
    Object.keys(cfg).filter((k) => !["name", "from", "version"].includes(k)).sort(),
    Object.keys(original).sort()
  );
});

test("the model declares the BambuStudio schema and its version", () => {
  const r = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8) });
  const xml = strFromU8(unzipSync(r.bytes)[MODEL_FILE]);
  assert.ok(xml.includes('xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"'));
  assert.ok(xml.includes('<metadata name="BambuStudio:3mfVersion">1</metadata>'));
  assert.ok(xml.includes("xmlns:p="), "the engine's production namespace must survive");
});

test("PROVENANCE IS NOT FORGED — the file never claims Bambu Studio made it", () => {
  // BambuStudio sets m_is_bbl_3mf from an Application value starting with
  // "BambuStudio-" (bbs_3mf.cpp:4234). Writing that here would be a false
  // statement of origin, made to pass someone else's origin check. This test
  // exists so no later edit can quietly introduce it.
  const r = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8) });
  const xml = strFromU8(unzipSync(r.bytes)[MODEL_FILE]);
  assert.ok(xml.includes('<metadata name="Application">LEVO Studio-1.0.0</metadata>'));
  assert.equal(xml.includes("BambuStudio-"), false, "must not claim BambuStudio provenance");
  assert.equal(xml.includes("ThreeSlicer"), false, "the library name is not the producing app");
});

test("a relationship is only written when its target exists", () => {
  const none = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: null, thumbnailSmallPng: null });
  const rels = strFromU8(unzipSync(none.bytes)[RELS_FILE]);
  assert.ok(rels.includes('Id="rel-1"'));
  for (const id of ["rel-2", "rel-4", "rel-5"]) assert.equal(rels.includes(id), false, id);
  assert.equal(unzipSync(none.bytes)[PLATE_THUMBNAIL_FILE], undefined);
  assert.ok(none.warnings.some((w) => w.includes("preview")));

  const both = strFromU8(
    unzipSync(toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8), thumbnailSmallPng: png(4) }).bytes)[RELS_FILE]
  );
  for (const id of ["rel-1", "rel-2", "rel-4", "rel-5"]) assert.ok(both.includes(`Id="${id}"`), id);
  assert.equal(both.includes("rel-3"), false, "upstream has no rel-3 and none is invented");
});

test("slice_info carries no invented print results", () => {
  // Upstream fills a plate with predicted time, weight and first-layer time.
  // LEVO has none of those without a slice, and a file the customer publishes
  // must not carry numbers nobody measured.
  const xml = sliceInfoXml({ application: "LEVO Studio-1.0.0", printerModelId: "C11", nozzleDiameters: "0.4" });
  assert.ok(xml.includes('key="X-BBL-Client-Type" value="slicer"'));
  assert.ok(xml.includes('key="printer_model_id" value="C11"'));
  for (const invented of ["prediction", "weight", "first_layer_time", "outside"]) {
    assert.equal(xml.includes(invented), false, `slice_info invented ${invented}`);
  }
});

test("[Content_Types].xml matches upstream exactly", () => {
  const x = contentTypesXml();
  assert.equal(x.split("\n").length, 7);
  assert.equal(x.endsWith("</Types>"), true, "upstream writes no trailing newline");
  for (const ext of ["rels", "model", "png", "gcode"]) assert.ok(x.includes(`Extension="${ext}"`), ext);
});

test("Arabic project names and XML metacharacters are escaped", () => {
  const r = toBambuProject(engine3mf(), { ...OPTS, projectName: 'A & B <"x">', thumbnailPng: png(8) });
  const xml = strFromU8(unzipSync(r.bytes)[MODEL_FILE]);
  assert.ok(xml.includes('<metadata name="Title">A &amp; B &lt;&quot;x&quot;&gt;</metadata>'));
  assert.equal(xmlEscape("a'b"), "a&apos;b");
});

test("converting twice changes nothing further", () => {
  const once = toBambuProject(engine3mf(), { ...OPTS, thumbnailPng: png(8) });
  const twice = toBambuProject(once.bytes, { ...OPTS, thumbnailPng: png(8) });
  const a = unzipSync(once.bytes);
  const b = unzipSync(twice.bytes);
  for (const f of [MODEL_FILE, PROJECT_SETTINGS_FILE, RELS_FILE]) {
    assert.equal(strFromU8(b[f]), strFromU8(a[f]), f);
  }
});

test("a project with no settings file is reported, not faked", () => {
  const bare = zipSync({
    [MODEL_FILE]: strToU8(ENGINE_MODEL_XML),
    [MODEL_SETTINGS_FILE]: strToU8(ENGINE_MODEL_SETTINGS),
  });
  const r = toBambuProject(bare, { ...OPTS, thumbnailPng: png(8) });
  assert.equal(unzipSync(r.bytes)[PROJECT_SETTINGS_FILE], undefined);
  assert.ok(r.warnings.some((w) => w.includes("preset unchanged")));
});

test("something that is not a 3MF is refused", () => {
  assert.throws(() => toBambuProject(zipSync({ "readme.txt": strToU8("hi") }), OPTS), /3dmodel\.model is missing/);
});

test("stampModelXml leaves a file with no <model> element alone", () => {
  const r = stampModelXml("<nope/>", { application: "x", projectName: "y", createdAt: "z" });
  assert.equal(r.changed, false);
  assert.equal(r.xml, "<nope/>");
});

test("stampProjectSettings survives malformed JSON without destroying it", () => {
  const r = stampProjectSettings("{not json", { version: "1" });
  assert.equal(r.changed, false);
  assert.equal(r.json, "{not json");
});

test("relsXml never emits rel-5 without a small thumbnail", () => {
  assert.equal(relsXml(true, false).includes("rel-5"), false);
  assert.ok(relsXml(true, false).includes("rel-4"));
});
