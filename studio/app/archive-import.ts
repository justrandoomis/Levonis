import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { MODEL_EXTENSIONS } from "./model-loaders";

export const MODEL_EXTENSION_SET = new Set<string>(MODEL_EXTENSIONS);
export const FILE_PICKER_ACCEPT = [...MODEL_EXTENSIONS.map((extension) => `.${extension}`), ".zip"].join(",");

export interface ArchiveProgress {
  compressedRead: number;
  compressedTotal: number;
  extractedFiles: number;
}

export function fileExtension(name: string) {
  const leaf = name.split(/[\\/]/).pop() || name;
  const dot = leaf.lastIndexOf(".");
  return dot < 0 ? "" : leaf.slice(dot + 1).toLowerCase();
}

function inferredExtension(bytes: Uint8Array, totalSize: number) {
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "glTF") return "glb";
  if (bytes[0] === 0x4d && bytes[1] === 0x4d) return "3ds";
  if (text.startsWith("ISO-10303-21")) return "step";
  if (text.startsWith("DBRep_DrawableShape")) return "brep";
  if (text.startsWith("#VRML")) return "wrl";
  if (/^OFF(?:\s|$)/.test(text)) return "off";
  if (/^ply(?:\s|$)/.test(text)) return "ply";
  if (/^solid\s/i.test(text) && /\bfacet\s+normal\b/i.test(text)) return "stl";
  if (/^(?:#.*\n)*(?:v|o|g)\s+/m.test(text) && /^f\s+/m.test(text)) return "obj";
  if (/<COLLADA\b/i.test(text)) return "dae";
  if (/^Kaydara FBX Binary/.test(text)) return "fbx";
  if (/^\s*\{/.test(text) && /"asset"\s*:\s*\{/.test(text)) return "gltf";
  if (bytes.length >= 84) {
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (triangles > 0 && 84 + triangles * 50 === totalSize) return "stl";
  }
  return "";
}

export async function normalizeModelFile(file: File) {
  const extension = fileExtension(file.name);
  if (MODEL_EXTENSION_SET.has(extension) || extension === "zip") return file;
  const sample = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const inferred = inferredExtension(sample, file.size);
  if (!inferred) throw new Error(`Unsupported or unrecognized model file: ${file.name}`);
  return new File([file], `${file.name}.${inferred}`, { type: file.type, lastModified: file.lastModified });
}

function mergeChunks(chunks: Uint8Array[], size: number) {
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function safeArchiveName(name: string, used: Map<string, number>) {
  const flattened = name.replace(/^\/+/, "").replace(/(?:^|[\\/])\.\.(?=[\\/]|$)/g, "").replace(/[\\/]+/g, "__");
  const base = flattened || "model";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (!count) return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}-${count + 1}${base.slice(dot)}` : `${base}-${count + 1}`;
}

export async function extractModelArchive(file: File, onProgress?: (progress: ArchiveProgress) => void) {
  const files: File[] = [];
  const usedNames = new Map<string, number>();
  let pending = 0;
  let archiveEnded = false;
  let settled = false;
  let compressedRead = 0;

  return new Promise<File[]>((resolve, reject) => {
    const finish = () => {
      if (settled || !archiveEnded || pending) return;
      settled = true;
      if (!files.length) reject(new Error("The ZIP archive does not contain a supported 3D model."));
      else resolve(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    const unzip = new Unzip((entry) => {
      const extension = fileExtension(entry.name);
      if ((!MODEL_EXTENSION_SET.has(extension) && extension) || entry.name.endsWith("/")) return;
      pending += 1;
      const chunks: Uint8Array[] = [];
      let expandedSize = 0;
      entry.ondata = (error, data, final) => {
        if (error) { fail(error); return; }
        chunks.push(data);
        expandedSize += data.length;
        if (!final) return;
        const extracted = new File([mergeChunks(chunks, expandedSize)], safeArchiveName(entry.name, usedNames), {
          type: "application/octet-stream",
          lastModified: file.lastModified,
        });
        void normalizeModelFile(extracted).then((normalized) => {
          files.push(normalized);
          pending -= 1;
          onProgress?.({ compressedRead, compressedTotal: file.size, extractedFiles: files.length });
          finish();
        }).catch(() => {
          pending -= 1;
          finish();
        });
      };
      try { entry.start(); } catch (reason) { fail(reason); }
    });
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);

    void (async () => {
      try {
        const reader = file.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          compressedRead += value.byteLength;
          unzip.push(value, false);
          onProgress?.({ compressedRead, compressedTotal: file.size, extractedFiles: files.length });
        }
        unzip.push(new Uint8Array(0), true);
        archiveEnded = true;
        finish();
      } catch (reason) {
        fail(reason);
      }
    })();
  });
}
