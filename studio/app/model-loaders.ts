import * as THREE from "three";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import type { LoadedObject } from "three-slicer/viewer/loaders";
import { registerLoader } from "three-slicer/viewer/loaders";

export const BUILTIN_MODEL_EXTENSIONS = ["stl", "obj", "3mf", "amf", "ply"] as const;
export const EXTENDED_MODEL_EXTENSIONS = [
  "glb", "gltf", "fbx", "dae", "3ds", "wrl", "vrml", "off",
  "usdz", "kmz", "vtk", "vtp", "md2",
  "step", "stp", "iges", "igs", "brep", "brp",
] as const;
export const MODEL_EXTENSIONS = [...BUILTIN_MODEL_EXTENSIONS, ...EXTENDED_MODEL_EXTENSIONS] as const;

let registered = false;
let cadModulePromise: Promise<OcctModule> | null = null;

interface OcctMesh {
  name?: string;
  attributes?: { position?: { array?: number[] } };
  index?: { array?: number[] | number[][] };
}

interface OcctResult {
  success: boolean;
  meshes?: OcctMesh[];
}

interface OcctModule {
  ReadStepFile(data: Uint8Array, params: Record<string, unknown>): OcctResult;
  ReadIgesFile(data: Uint8Array, params: Record<string, unknown>): OcctResult;
  ReadBrepFile(data: Uint8Array, params: Record<string, unknown>): OcctResult;
}

function fileStem(name: string) {
  const leaf = name.split(/[\\/]/).pop() || name;
  return leaf.replace(/\.[^.]+$/, "") || "model";
}

function geometryTriangles(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) {
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) return null;
  const index = geometry.getIndex();
  const count = Math.floor((index ? index.count : position.count) / 3) * 3;
  const output = new Float32Array(count * 3);
  const point = new THREE.Vector3();
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const sourceIndex = index ? index.getX(i) : i;
    point.fromBufferAttribute(position, sourceIndex).applyMatrix4(matrix);
    output[cursor++] = point.x;
    output[cursor++] = point.y;
    output[cursor++] = point.z;
  }
  return output.length >= 9 ? output : null;
}

function sceneObjects(root: THREE.Object3D, sourceName: string): LoadedObject[] {
  root.updateMatrixWorld(true);
  const models: LoadedObject[] = [];
  let part = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const modelPos = geometryTriangles(mesh.geometry, mesh.matrixWorld);
    if (!modelPos) return;
    part += 1;
    models.push({
      name: mesh.name?.trim() || `${fileStem(sourceName)}${part > 1 ? ` #${part}` : ""}`,
      modelPos,
    });
  });
  if (!models.length) throw new Error(`No printable mesh found in ${sourceName}`);
  return models;
}

function geometryObjects(geometry: THREE.BufferGeometry, sourceName: string) {
  return sceneObjects(new THREE.Mesh(geometry), sourceName);
}

function parseOff(buffer: ArrayBuffer, name: string): LoadedObject[] {
  const lines = new TextDecoder().decode(buffer)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].startsWith("OFF")) throw new Error("Invalid OFF header");
  const headerValues = lines[0].slice(3).trim().split(/\s+/).filter(Boolean);
  const counts = headerValues.length >= 2 ? headerValues : (lines.shift(), lines.shift()?.split(/\s+/) ?? []);
  const vertexCount = Number(counts[0]);
  const faceCount = Number(counts[1]);
  if (!Number.isInteger(vertexCount) || !Number.isInteger(faceCount) || vertexCount < 3 || faceCount < 1) {
    throw new Error("Invalid OFF counts");
  }
  if (lines[0]?.startsWith("OFF")) lines.shift();
  const vertices: number[][] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const values = (lines[i] || "").split(/\s+/).map(Number);
    if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) throw new Error("Invalid OFF vertex");
    vertices.push(values.slice(0, 3));
  }
  const triangles: number[] = [];
  for (let i = 0; i < faceCount; i += 1) {
    const values = (lines[vertexCount + i] || "").split(/\s+/).map(Number);
    const polygonSize = values[0];
    const indices = values.slice(1, polygonSize + 1);
    if (!Number.isInteger(polygonSize) || polygonSize < 3 || indices.some((index) => !vertices[index])) continue;
    for (let corner = 1; corner < indices.length - 1; corner += 1) {
      triangles.push(...vertices[indices[0]], ...vertices[indices[corner]], ...vertices[indices[corner + 1]]);
    }
  }
  if (triangles.length < 9) throw new Error("No printable faces in OFF file");
  return [{ name: fileStem(name), modelPos: new Float32Array(triangles) }];
}

async function loadCadModule() {
  if (cadModulePromise) return cadModulePromise;
  const promise = import("occt-import-js").then(async (module) => {
    const loaded = await module.default({ locateFile: () => occtWasmUrl });
    return loaded as unknown as OcctModule;
  });
  cadModulePromise = promise;
  return promise;
}

function expandOcctMesh(mesh: OcctMesh, fallbackName: string): LoadedObject | null {
  const vertices = mesh.attributes?.position?.array ?? [];
  const rawIndex = mesh.index?.array ?? [];
  const indices = (Array.isArray(rawIndex[0]) ? (rawIndex as number[][]).flat() : rawIndex) as number[];
  if (vertices.length < 9 || indices.length < 3) return null;
  const positions = new Float32Array(Math.floor(indices.length / 3) * 9);
  let cursor = 0;
  for (const index of indices.slice(0, Math.floor(indices.length / 3) * 3)) {
    const offset = index * 3;
    if (offset + 2 >= vertices.length) return null;
    positions[cursor++] = vertices[offset];
    positions[cursor++] = vertices[offset + 1];
    positions[cursor++] = vertices[offset + 2];
  }
  return { name: mesh.name?.trim() || fallbackName, modelPos: positions };
}

async function parseCad(buffer: ArrayBuffer, name: string, kind: "step" | "iges" | "brep") {
  const occt = await loadCadModule();
  const params = {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  };
  const bytes = new Uint8Array(buffer);
  const result = kind === "step"
    ? occt.ReadStepFile(bytes, params)
    : kind === "iges"
      ? occt.ReadIgesFile(bytes, params)
      : occt.ReadBrepFile(bytes, params);
  if (!result.success) throw new Error(`OpenCascade could not read ${name}`);
  const meshes = (result.meshes ?? [])
    .map((mesh, index) => expandOcctMesh(mesh, `${fileStem(name)} #${index + 1}`))
    .filter((mesh): mesh is LoadedObject => Boolean(mesh));
  if (!meshes.length) throw new Error(`No printable CAD mesh found in ${name}`);
  return meshes;
}

export async function registerExtendedModelLoaders() {
  if (registered) return;
  registered = true;

  registerLoader(["glb", "gltf"], async (buffer, name) => {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const data = name.toLowerCase().endsWith(".gltf") ? new TextDecoder().decode(buffer) : buffer;
    const gltf = await new GLTFLoader().parseAsync(data, "");
    return sceneObjects(gltf.scene, name);
  });
  registerLoader("fbx", async (buffer, name) => {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    return sceneObjects(new FBXLoader().parse(buffer, ""), name);
  });
  registerLoader("dae", async (buffer, name) => {
    const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
    return sceneObjects(new ColladaLoader().parse(new TextDecoder().decode(buffer), "").scene, name);
  });
  registerLoader("3ds", async (buffer, name) => {
    const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
    return sceneObjects(new TDSLoader().parse(buffer, ""), name);
  });
  registerLoader(["wrl", "vrml"], async (buffer, name) => {
    const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
    return sceneObjects(new VRMLLoader().parse(new TextDecoder().decode(buffer), ""), name);
  });
  registerLoader("usdz", async (buffer, name) => {
    const { USDZLoader } = await import("three/examples/jsm/loaders/USDZLoader.js");
    return sceneObjects(new USDZLoader().parse(buffer), name);
  });
  registerLoader("kmz", async (buffer, name) => {
    const { KMZLoader } = await import("three/examples/jsm/loaders/KMZLoader.js");
    return sceneObjects(new KMZLoader().parse(buffer).scene, name);
  });
  registerLoader(["vtk", "vtp"], async (buffer, name) => {
    const { VTKLoader } = await import("three/examples/jsm/loaders/VTKLoader.js");
    return geometryObjects(new VTKLoader().parse(buffer, ""), name);
  });
  registerLoader("md2", async (buffer, name) => {
    const { MD2Loader } = await import("three/examples/jsm/loaders/MD2Loader.js");
    return geometryObjects(new MD2Loader().parse(buffer), name);
  });
  registerLoader("off", (buffer, name) => parseOff(buffer, name));
  registerLoader(["step", "stp"], (buffer, name) => parseCad(buffer, name, "step"));
  registerLoader(["iges", "igs"], (buffer, name) => parseCad(buffer, name, "iges"));
  registerLoader(["brep", "brp"], (buffer, name) => parseCad(buffer, name, "brep"));
}
