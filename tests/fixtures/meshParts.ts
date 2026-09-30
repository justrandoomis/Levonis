/**
 * MESH FIXTURES for the blueprint compiler (Programme C, C1 lane L4).
 *
 * Real bytes in the shapes real exporters write, so `parseModelParts` and the
 * compiler are held to files a merchant actually has on disk:
 *
 *   - a Bambu Studio / Orca assembly: the root model holds only an object with
 *     `<components>`, the meshes live in a SECOND model part
 *     (`3D/Objects/object_1.model`, reached through `p:path`), the part names,
 *     subtypes and extruders live in `Metadata/model_settings.config` and the
 *     filament colours in `Metadata/project_settings.config` — the package
 *     `analyseModel` cannot measure today;
 *   - a core 3MF with two build items and two colour resources
 *     (`<basematerials displaycolor>` and the materials extension's
 *     `<m:colorgroup><m:color color>`);
 *   - a PrusaSlicer 3MF: one object mesh whose triangle ranges are the volumes
 *     named in `Metadata/Slic3r_PE_model.config`;
 *   - an OBJ with `o` / `g` / `usemtl` groups and negative indices;
 *   - a GLB with named nodes, a TRS parent (a rotation) and a matrix child,
 *     in metres with Y up, as the glTF specification defines;
 *   - plain STL files (binary and multi-solid ASCII).
 *
 * Every builder returns bytes; nothing here parses. The box winding is the
 * one `tests/modelGeometry.test.ts` uses (outward normals).
 */
import { zipSync, strToU8 } from 'fflate';

/** Nine numbers: three corners of one triangle. */
export type Tri = number[];

// ------------------------------------------------------------------ boxes

/** The 12 triangles of an axis-aligned box, wound so the normals point out. */
export function boxTriangles(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): Tri[] {
  const v = (i: number, j: number, k: number) => [ox + i * sx, oy + j * sy, oz + k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    [p000, p110, p100], [p000, p010, p110],
    [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010],
    [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
}

/** The same box as 8 shared corners and 12 index triples (3MF, OBJ, glTF). */
export function boxIndexed(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0) {
  const vertices = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ].map(([x, y, z]) => [x + ox, y + oy, z + oz]);
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return { vertices, faces };
}

/**
 * A UV sphere as a triangle soup — the "organic" shape of the measures (every
 * coordinate distinct, the worst case for gzip). `segments × rings × 2`
 * triangles, the two pole rows included as slivers so the count is exact.
 */
export function sphereTriangles(radius: number, segments: number, rings: number, cx = 0, cy = 0, cz = 0): Tri[] {
  const out: Tri[] = [];
  const p = (i: number, j: number) => {
    const th = (i / rings) * Math.PI;
    const ph = (j / segments) * 2 * Math.PI;
    return [cx + radius * Math.sin(th) * Math.cos(ph), cy + radius * Math.sin(th) * Math.sin(ph), cz + radius * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
      out.push([a, b, c].flat(), [a, c, d].flat());
    }
  }
  return out;
}

/**
 * A "CAD-like" plate: an axis-aligned grid of `n × n` cells on a box face
 * (coplanar, repeated coordinates — the case gzip compresses best), closed by
 * a box. `2·n² + 12` triangles.
 */
export function gridPlateTriangles(size: number, n: number, height: number): Tri[] {
  const out: Tri[] = [];
  const step = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = i * step, y0 = j * step, x1 = x0 + step, y1 = y0 + step;
      out.push([x0, y0, height, x1, y0, height, x1, y1, height], [x0, y0, height, x1, y1, height, x0, y1, height]);
    }
  }
  return [...out, ...boxTriangles(size, size, height * 0.999)];
}

/**
 * The same UV sphere as SHARED vertices and index triples — how real exporters
 * write a 3MF (each vertex once), so a measured package compresses like a
 * real one. `segments × rings × 2` triangles.
 */
export function sphereIndexed(radius: number, segments: number, rings: number, cx = 0, cy = 0, cz = 0) {
  const vertices: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j < segments; j++) {
      const th = (i / rings) * Math.PI;
      const ph = (j / segments) * 2 * Math.PI;
      vertices.push([cx + radius * Math.sin(th) * Math.cos(ph), cy + radius * Math.sin(th) * Math.sin(ph), cz + radius * Math.cos(th)]);
    }
  }
  const at = (i: number, j: number) => i * segments + (j % segments);
  const faces: number[][] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  return { vertices, faces };
}

/** A float as a slicer writes it: the float32 value at nine significant digits. */
export const slicerFloat = (x: number) => String(Number(Math.fround(x).toPrecision(9)));

/** Triangles → indexed (no sharing; enough for writers that need indices). */
export function indexedFromTris(tris: Tri[]) {
  const vertices: number[][] = [];
  const faces: number[][] = [];
  for (const t of tris) {
    const base = vertices.length;
    vertices.push([t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]);
    faces.push([base, base + 1, base + 2]);
  }
  return { vertices, faces };
}

// -------------------------------------------------------------------- STL

export function binaryStl(tris: Tri[], header = 'levonis fixture'): Uint8Array {
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < Math.min(header.length, 79); i++) out[i] = header.charCodeAt(i);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) {
      dv.setFloat32(at, t[i], true);
      at += 4;
    }
    at += 2;
  }
  return out;
}

/** One or more `solid … endsolid` blocks in one ASCII file. */
export function asciiStl(solids: Array<{ name: string; tris: Tri[] }>): Uint8Array {
  let s = '';
  for (const { name, tris } of solids) {
    s += `solid ${name}\n`;
    for (const t of tris) {
      s += '  facet normal 0 0 0\n    outer loop\n';
      for (let v = 0; v < 3; v++) s += `      vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}\n`;
      s += '    endloop\n  endfacet\n';
    }
    s += `endsolid ${name}\n`;
  }
  return new TextEncoder().encode(s);
}

// -------------------------------------------------------------------- 3MF

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const MAT_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

/** `<mesh>` of an indexed shape, attributes in the order Bambu writes them. */
export function meshXml(vertices: number[][], faces: number[][], triangleAttrs = '', fmt: (x: number) => string = String): string {
  return (
    '<mesh><vertices>' +
    vertices.map((v) => `<vertex x="${fmt(v[0])}" y="${fmt(v[1])}" z="${fmt(v[2])}"/>`).join('') +
    '</vertices><triangles>' +
    faces.map((f) => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"${triangleAttrs}/>`).join('') +
    '</triangles></mesh>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '<Default Extension="png" ContentType="image/png"/></Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

/** A 3MF package from its parts (the two OPC bookkeeping parts are added). */
export function zip3mf(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
  };
  for (const [name, body] of Object.entries(files)) entries[name] = typeof body === 'string' ? strToU8(body) : body;
  return zipSync(entries);
}

/** A 4×3 row-major 3MF transform string: nine rotation/scale terms, then the translation. */
export const T3 = {
  identity: '1 0 0 0 1 0 0 0 1 0 0 0',
  translate: (x: number, y: number, z: number) => `1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`,
  /** 90° about +Z (x → y, y → −x), then a translation. Row-vector convention: p' = p·M. */
  rotZ90: (x: number, y: number, z: number) => `0 1 0 -1 0 0 0 0 1 ${x} ${y} ${z}`,
};

export interface BambuOptions {
  /** The build item's transform (default: onto the plate at 128, 128). */
  itemTransform?: string;
  /** The name plate's component transform (default: translated by 2, 8, 5). */
  plateTransform?: string;
  /** Adds a `paint_color` attribute to the body's triangles (MMU painting). */
  painted?: boolean;
}

/**
 * A Bambu Studio assembly — what every multi-part Bambu/Orca export looks
 * like. The body is a 20×20×5 box; the name plate a 16×4×2 box placed on top
 * of it by its component transform; a modifier box that must never become a
 * part. Extruder 1 is white, extruder 2 red.
 */
export function bambuAssembly3mf(opts: BambuOptions = {}): Uint8Array {
  const body = boxIndexed(20, 20, 5);
  const plate = boxIndexed(16, 4, 2);
  const modifier = boxIndexed(5, 5, 5);
  const paint = opts.painted ? ' paint_color="4"' : '';
  const objectsXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" ` +
    `xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${PROD_NS}" requiredextensions="p">\n` +
    ` <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n` +
    `  <object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">${meshXml(body.vertices, body.faces, paint)}</object>\n` +
    `  <object id="2" p:UUID="00020000-81cb-4c03-9d28-80fed5dfa1dc" type="model">${meshXml(plate.vertices, plate.faces)}</object>\n` +
    `  <object id="3" p:UUID="00030000-81cb-4c03-9d28-80fed5dfa1dc" type="model">${meshXml(modifier.vertices, modifier.faces)}</object>\n` +
    ' </resources>\n <build/>\n</model>\n';
  const rootXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" ` +
    `xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${PROD_NS}" requiredextensions="p">\n` +
    ' <metadata name="Application">BambuStudio-01.09.03.50</metadata>\n' +
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    ' <metadata name="Title"></metadata>\n' +
    ' <resources>\n' +
    '  <object id="4" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <components>\n' +
    `    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="${T3.identity}"/>\n` +
    `    <component p:path="/3D/Objects/object_1.model" objectid="2" p:UUID="00010001-b206-40ff-9872-83e8017abed1" transform="${opts.plateTransform ?? T3.translate(2, 8, 5)}"/>\n` +
    `    <component p:path="/3D/Objects/object_1.model" objectid="3" p:UUID="00010002-b206-40ff-9872-83e8017abed1" transform="${T3.identity}"/>\n` +
    '   </components>\n  </object>\n </resources>\n' +
    ' <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n' +
    `  <item objectid="4" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="${opts.itemTransform ?? T3.translate(128, 128, 0)}" printable="1"/>\n` +
    ' </build>\n</model>\n';
  const settings =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="4">\n' +
    '    <metadata key="name" value="Keychain"/>\n    <metadata key="extruder" value="1"/>\n' +
    '    <part id="1" subtype="normal_part">\n      <metadata key="name" value="Body"/>\n' +
    '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="1"/>\n' +
    '      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n    </part>\n' +
    '    <part id="2" subtype="normal_part">\n      <metadata key="name" value="Name plate"/>\n      <metadata key="extruder" value="2"/>\n    </part>\n' +
    '    <part id="3" subtype="modifier_part">\n      <metadata key="name" value="Infill modifier"/>\n    </part>\n' +
    '  </object>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <model_instance>\n' +
    '      <metadata key="object_id" value="4"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n' +
    '  <assemble>\n   <assemble_item object_id="4" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />\n  </assemble>\n</config>\n';
  const project = JSON.stringify({
    filament_colour: ['#FFFFFF', '#D32F2F'],
    filament_type: ['PLA', 'PLA'],
    printer_model: 'Bambu Lab P1S',
  });
  const modelRels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zip3mf({
    '3D/3dmodel.model': rootXml,
    '3D/_rels/3dmodel.model.rels': modelRels,
    '3D/Objects/object_1.model': objectsXml,
    'Metadata/model_settings.config': settings,
    'Metadata/project_settings.config': project,
    'Metadata/plate_1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  });
}

/**
 * A core 3MF with two build items and two colour resources: «Base» takes its
 * colour from `<basematerials displaycolor>`, «Lid» from the materials
 * extension's `<m:colorgroup>`, and the lid is placed 12 mm up by its item.
 */
export function twoItem3mf(unit = 'millimeter'): Uint8Array {
  const base = boxIndexed(30, 30, 10);
  const lid = boxIndexed(30, 30, 3);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xmlns="${CORE_NS}" xmlns:m="${MAT_NS}">` +
    '<metadata name="Title">Box &amp; lid</metadata><resources>' +
    '<basematerials id="1"><base name="PLA Green" displaycolor="#1B7F3BFF"/><base name="PLA White" displaycolor="#FFFFFF"/></basematerials>' +
    '<m:colorgroup id="5"><m:color color="#000000"/><m:color color="#FFC107"/></m:colorgroup>' +
    `<object id="2" type="model" name="Base" pid="1" pindex="0">${meshXml(base.vertices, base.faces)}</object>` +
    `<object id="3" type="model" name="Lid" pid="5" pindex="1">${meshXml(lid.vertices, lid.faces)}</object>` +
    '</resources><build>' +
    '<item objectid="2"/>' +
    `<item objectid="3" transform="${T3.translate(0, 0, 12)}"/>` +
    '</build></model>';
  return zip3mf({ '3D/3dmodel.model': xml });
}

/**
 * A PrusaSlicer project: ONE object mesh holding two volumes back to back
 * (triangles 0–11 the body, 12–23 the text) plus a modifier (24–35), split by
 * `Metadata/Slic3r_PE_model.config`; colours from `Metadata/Slic3r_PE.config`.
 */
export function prusaVolumes3mf(): Uint8Array {
  const body = boxIndexed(40, 20, 4);
  const text = boxIndexed(30, 6, 1.5, 5, 7, 4);
  const mod = boxIndexed(10, 10, 4);
  const vertices = [...body.vertices, ...text.vertices, ...mod.vertices];
  const faces = [
    ...body.faces,
    ...text.faces.map((f) => f.map((i) => i + 8)),
    ...mod.faces.map((f) => f.map((i) => i + 16)),
  ];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">` +
    '<metadata name="slic3rpe:Version3mf">1</metadata><resources>' +
    `<object id="1" type="model">${meshXml(vertices, faces)}</object>` +
    `</resources><build><item objectid="1" transform="${T3.translate(100, 100, 0)}" printable="1"/></build></model>`;
  const config =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n' +
    '  <metadata type="object" key="name" value="Sign"/>\n' +
    '  <volume firstid="0" lastid="11">\n   <metadata type="volume" key="name" value="Sign body"/>\n' +
    '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n   <metadata type="volume" key="extruder" value="1"/>\n  </volume>\n' +
    '  <volume firstid="12" lastid="23">\n   <metadata type="volume" key="name" value="Raised text"/>\n' +
    '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n   <metadata type="volume" key="extruder" value="2"/>\n  </volume>\n' +
    '  <volume firstid="24" lastid="35">\n   <metadata type="volume" key="name" value="Modifier"/>\n' +
    '   <metadata type="volume" key="volume_type" value="ParameterModifier"/>\n  </volume>\n' +
    ' </object>\n</config>\n';
  const ini = '; generated by PrusaSlicer 2.7.1\n; extruder_colour = "";"#00FF00"\n; filament_colour = #1E88E5;#FF8000\n';
  return zip3mf({
    '3D/3dmodel.model': xml,
    'Metadata/Slic3r_PE_model.config': config,
    'Metadata/Slic3r_PE.config': ini,
  });
}

// -------------------------------------------------------------------- OBJ

/**
 * An OBJ with `o` / `g` / `usemtl`: «Body» (one material) and an object
 * «Name» whose group «Letters» carries two materials — addressed partly with
 * negative (relative) indices, as exporters do.
 */
export function objGroups(): Uint8Array {
  const body = boxIndexed(20, 20, 5);
  const name = boxIndexed(16, 4, 2, 2, 8, 5);
  let s = '# levonis fixture\nmtllib parts.mtl\n';
  s += 'o Body\n';
  for (const v of body.vertices) s += `v ${v[0]} ${v[1]} ${v[2]}\n`;
  s += 'usemtl Red\n';
  for (const f of body.faces) s += `f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}\n`;
  s += 'o Name\n';
  for (const v of name.vertices) s += `v ${v[0]} ${v[1]} ${v[2]}\n`;
  s += 'g Letters\nusemtl White\n';
  // Relative indices: -8 is the first of the eight vertices just written.
  for (const f of name.faces.slice(0, 6)) s += `f ${f[0] - 8}/1 ${f[1] - 8}/1 ${f[2] - 8}/1\n`;
  s += 'usemtl Black\n';
  for (const f of name.faces.slice(6)) s += `f ${f[0] + 9}//1 ${f[1] + 9}//1 ${f[2] + 9}//1\n`;
  return new TextEncoder().encode(s);
}

/** An OBJ with `count` separate one-quad objects (2 triangles each), for the 64-part rule. */
export function objManyObjects(count: number, materialsPerObject = 1): Uint8Array {
  let s = '';
  let vertices = 0;
  for (let i = 0; i < count; i++) {
    s += `o piece_${i}\n`;
    for (let m = 0; m < materialsPerObject; m++) {
      const x = i * 3, y = m * 3;
      s += `v ${x} ${y} 0\nv ${x + 1} ${y} 0\nv ${x + 1} ${y + 1} 0\nv ${x} ${y + 1} 0\n`;
      if (materialsPerObject > 1) s += `usemtl m${m}\n`;
      s += `f ${vertices + 1} ${vertices + 2} ${vertices + 3} ${vertices + 4}\n`;
      vertices += 4;
    }
  }
  return new TextEncoder().encode(s);
}

// ------------------------------------------------------------- glTF / GLB

/** A GLB container around a glTF JSON document and one binary buffer. */
export function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length + pad4(jsonBytes.length);
  const binLen = bin.length + pad4(bin.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonLen; i++) out[20 + i] = 0x20;
  const at = 20 + jsonLen;
  dv.setUint32(at, binLen, true);
  dv.setUint32(at + 4, 0x004e4942, true);
  out.set(bin, at + 8);
  return out;
}

/** Packs indexed meshes into one buffer and returns the accessors that address them. */
function packMeshes(meshes: Array<{ vertices: number[][]; faces: number[][] }>) {
  const chunks: Uint8Array[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    const at = offset;
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    return at;
  };
  const refs: Array<{ position: number; indices: number }> = [];
  for (const m of meshes) {
    const pos = new Float32Array(m.vertices.flat());
    const idx = new Uint16Array(m.faces.flat());
    const posAt = push(new Uint8Array(pos.buffer));
    bufferViews.push({ buffer: 0, byteOffset: posAt, byteLength: pos.byteLength });
    const min = [0, 1, 2].map((k) => Math.min(...m.vertices.map((v) => v[k])));
    const max = [0, 1, 2].map((k) => Math.max(...m.vertices.map((v) => v[k])));
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: m.vertices.length, type: 'VEC3', min, max });
    const position = accessors.length - 1;
    const idxAt = push(new Uint8Array(idx.buffer));
    bufferViews.push({ buffer: 0, byteOffset: idxAt, byteLength: idx.byteLength });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5123, count: idx.length, type: 'SCALAR' });
    refs.push({ position, indices: accessors.length - 1 });
  }
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  return { bin, bufferViews, accessors, refs };
}

/**
 * A GLB in METRES with Y UP, as glTF defines it: a parent node «Stand»
 * (TRS: rotated 180° about Y and moved 0.1 m along X) with two named children —
 * «Base» (a 30 × 10 × 30 mm box, grey) and «Topper» (a 10 × 20 × 10 mm box,
 * red) placed by a MATRIX 10 mm along each axis. Read into the print frame
 * (millimetres, Z up) the base spans x 70…100, y 0…30, z 0…10 and the topper
 * x 80…90, y 10…20, z 10…30.
 */
export function glbNodes(): Uint8Array {
  const base = boxIndexed(0.03, 0.01, 0.03);
  const topper = boxIndexed(0.01, 0.02, 0.01);
  const { bin, bufferViews, accessors, refs } = packMeshes([base, topper]);
  const json = {
    asset: { version: '2.0', generator: 'levonis-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Stand', children: [1, 2], translation: [0.1, 0, 0], rotation: [0, 1, 0, 0] },
      { name: 'Base', mesh: 0 },
      { mesh: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.01, 0.01, 0.01, 1] },
    ],
    meshes: [
      { name: 'BaseMesh', primitives: [{ attributes: { POSITION: refs[0].position }, indices: refs[0].indices, material: 0 }] },
      { name: 'Topper', primitives: [{ attributes: { POSITION: refs[1].position }, indices: refs[1].indices, material: 1, mode: 4 }] },
    ],
    materials: [
      { name: 'Grey', pbrMetallicRoughness: { baseColorFactor: [0.2158605, 0.2158605, 0.2158605, 1] } },
      { name: 'Red', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  return glb(json, bin);
}

/** A GLB whose meshes are Draco-compressed (declared required): refused, never guessed. */
export function glbDraco(): Uint8Array {
  const json = {
    asset: { version: '2.0' },
    extensionsRequired: ['KHR_draco_mesh_compression'],
    extensionsUsed: ['KHR_draco_mesh_compression'],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  return glb(json, new Uint8Array(4));
}
