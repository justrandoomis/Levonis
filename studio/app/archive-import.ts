import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { MODEL_EXTENSIONS } from "./model-loaders";

export const MODEL_EXTENSION_SET = new Set<string>(MODEL_EXTENSIONS);
export const FILE_PICKER_ACCEPT = [...MODEL_EXTENSIONS.map((extension) => `.${extension}`), ".zip"].join(",");

export interface ArchiveProgress {
  compressedRead: number;
  compressedTotal: number;
  extractedFiles: number;
  /** Total bytes produced by decompression so far (all entries). */
  expandedBytes?: number;
  /** Entries skipped because their stored path was unsafe (traversal/absolute). */
  skippedUnsafeEntries?: number;
  /** Model-shaped entries that held no bytes, and so were not loaded. */
  emptyEntries?: number;
}

/**
 * Declared decompression limits (gap table §5 — ZIP archives / T7).
 *
 * ZIP contents are untrusted input: without a budget, a zip bomb expands until
 * the tab dies. These limits fail *before* memory exhaustion, with a typed
 * {@link ArchiveLimitError} the UI can present honestly. The soft budget
 * (`confirmExpandedBytes`) can be raised once per archive through the
 * `onBudgetExceeded` callback (a real user confirmation), but never beyond the
 * hard ceiling (`maxTotalExpandedBytes`).
 */
export interface ArchiveLimits {
  /** Hard cap on the number of entries the archive may declare. */
  maxEntries: number;
  /** Soft decompression budget; beyond it `onBudgetExceeded` is consulted. */
  confirmExpandedBytes: number;
  /** Hard decompression ceiling — never exceeded, even with confirmation. */
  maxTotalExpandedBytes: number;
  /** Hard cap on expandedBytes / compressedRead (zip-bomb signature). */
  maxExpansionRatio: number;
  /** The ratio check only applies once this many bytes have been expanded. */
  expansionRatioFloorBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 512,
  confirmExpandedBytes: 256 * 1024 * 1024,
  maxTotalExpandedBytes: 1024 * 1024 * 1024,
  maxExpansionRatio: 200,
  expansionRatioFloorBytes: 8 * 1024 * 1024,
};

export type ArchiveLimitCode = "entry-count" | "expansion-budget" | "expansion-ratio";

export class ArchiveLimitError extends Error {
  readonly code: ArchiveLimitCode;
  readonly limit: number;
  readonly observed: number;
  constructor(code: ArchiveLimitCode, message: string, limit: number, observed: number) {
    super(message);
    this.name = "ArchiveLimitError";
    this.code = code;
    this.limit = limit;
    this.observed = observed;
  }
}

export interface ExtractArchiveOptions {
  limits?: Partial<ArchiveLimits>;
  /**
   * Consulted once when the soft budget is exceeded. Return true to continue
   * up to the hard ceiling. Without this callback the soft budget is final —
   * the extraction fails with a clear `expansion-budget` error instead of
   * silently eating memory.
   */
  onBudgetExceeded?: (info: { expandedBytes: number; budgetBytes: number; hardLimitBytes: number }) => boolean | Promise<boolean>;
}

export function fileExtension(name: string) {
  const leaf = name.split(/[\\/]/).pop() || name;
  const dot = leaf.lastIndexOf(".");
  return dot < 0 ? "" : leaf.slice(dot + 1).toLowerCase();
}

/**
 * True for stored archive paths that must never be extracted: absolute paths,
 * Windows drive/UNC paths, `..` traversal segments, or NUL bytes. Such entries
 * are skipped (and counted) rather than sanitized into place.
 */
export function isUnsafeArchivePath(name: string): boolean {
  if (!name || name.includes("\0")) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  const segments = name.split(/[\\/]+/);
  return segments.some((segment) => segment === "..");
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

export async function extractModelArchive(
  file: File,
  onProgress?: (progress: ArchiveProgress) => void,
  options: ExtractArchiveOptions = {},
) {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const files: File[] = [];
  const usedNames = new Map<string, number>();
  let pending = 0;
  let archiveEnded = false;
  let settled = false;
  let compressedRead = 0;
  let expandedBytes = 0;
  let entryCount = 0;
  let skippedUnsafeEntries = 0;
  let emptyEntries = 0;
  let budgetConfirmed = false;
  let budgetPromptNeeded = false;

  const reportProgress = () => {
    onProgress?.({
      compressedRead,
      compressedTotal: file.size,
      extractedFiles: files.length,
      expandedBytes,
      skippedUnsafeEntries,
      emptyEntries,
    });
  };

  return new Promise<File[]>((resolve, reject) => {
    const finish = () => {
      if (settled || !archiveEnded || pending) return;
      settled = true;
      if (!files.length) {
        reject(new Error(
          skippedUnsafeEntries
            ? "The ZIP archive only contains entries with unsafe paths (absolute or traversal); nothing was extracted."
            : emptyEntries
              ? `The ZIP archive's ${emptyEntries} model entr${emptyEntries === 1 ? "y holds" : "ies hold"} no data.`
              : "The ZIP archive does not contain a supported 3D model."
        ));
      } else {
        resolve(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
      }
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    /**
     * Hard-stop checks that must run inside ondata (a single compressed chunk
     * can inflate to tens of megabytes before control returns to the read
     * loop). Returns false once extraction must stop.
     */
    const withinHardLimits = () => {
      if (settled) return false;
      if (expandedBytes > limits.maxTotalExpandedBytes) {
        fail(new ArchiveLimitError(
          "expansion-budget",
          `The archive expands beyond the hard decompression ceiling (${Math.round(limits.maxTotalExpandedBytes / (1024 * 1024))} MB).`,
          limits.maxTotalExpandedBytes,
          expandedBytes,
        ));
        return false;
      }
      if (expandedBytes > limits.expansionRatioFloorBytes && compressedRead > 0
        && expandedBytes / compressedRead > limits.maxExpansionRatio) {
        fail(new ArchiveLimitError(
          "expansion-ratio",
          `The archive expands more than ${limits.maxExpansionRatio}× its compressed size — refusing a likely zip bomb.`,
          limits.maxExpansionRatio,
          Math.round(expandedBytes / compressedRead),
        ));
        return false;
      }
      if (!budgetConfirmed && expandedBytes > limits.confirmExpandedBytes) {
        // Soft budget: pause for confirmation between reader chunks. Without a
        // confirmation callback the budget is final.
        budgetPromptNeeded = true;
        if (!options.onBudgetExceeded) {
          fail(new ArchiveLimitError(
            "expansion-budget",
            `The archive expands beyond the declared decompression budget (${Math.round(limits.confirmExpandedBytes / (1024 * 1024))} MB).`,
            limits.confirmExpandedBytes,
            expandedBytes,
          ));
          return false;
        }
      }
      return true;
    };
    const unzip = new Unzip((entry) => {
      if (settled) return;
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail(new ArchiveLimitError(
          "entry-count",
          `The archive declares more than ${limits.maxEntries} entries.`,
          limits.maxEntries,
          entryCount,
        ));
        return;
      }
      if (isUnsafeArchivePath(entry.name)) {
        skippedUnsafeEntries += 1;
        reportProgress();
        return;
      }
      const extension = fileExtension(entry.name);
      if ((!MODEL_EXTENSION_SET.has(extension) && extension) || entry.name.endsWith("/")) return;
      pending += 1;
      const chunks: Uint8Array[] = [];
      let expandedSize = 0;
      entry.ondata = (error, data, final) => {
        if (settled) return;
        if (error) { fail(error); return; }
        chunks.push(data);
        expandedSize += data.length;
        expandedBytes += data.length;
        if (!withinHardLimits()) return;
        if (!final) return;
        // A ZERO-BYTE ENTRY IS NOT A MODEL. The importer's own emptiness check
        // runs on the files the customer PICKED, and a ZIP is one file however
        // many entries it carries — so an empty `part.stl` inside it was never
        // looked at. `normalizeModelFile` then waves it straight through,
        // because `.stl` is a known extension and it only sniffs the ones that
        // are not, and the engine was handed an empty mesh to load.
        //
        // Dropped rather than refused: the archive's other parts are real, and
        // failing forty good models over one empty entry is a worse answer
        // than importing the forty. The count travels out on the progress
        // report either way, so it is not a silent loss.
        if (!expandedSize) {
          emptyEntries += 1;
          pending -= 1;
          reportProgress();
          finish();
          return;
        }
        const extracted = new File([mergeChunks(chunks, expandedSize)], safeArchiveName(entry.name, usedNames), {
          type: "application/octet-stream",
          lastModified: file.lastModified,
        });
        void normalizeModelFile(extracted).then((normalized) => {
          files.push(normalized);
          pending -= 1;
          reportProgress();
          finish();
        }).catch(() => {
          // AN ENTRY THAT FAILS HERE IS NOT A LOST MODEL, and this catch is
          // deliberate rather than an oversight. `normalizeModelFile` returns
          // immediately for every known model extension, so the only entries
          // that can reach it — and therefore the only ones that can fail —
          // are the ones with NO extension whose first 4 KB do not look like
          // any geometry format. A ZIP from any model site carries several:
          // LICENSE, README, a `.thumbnails` stub. Refusing the archive over
          // one of those, or reporting it as a dropped model, would both be
          // wrong.
          pending -= 1;
          finish();
        });
      };
      try { entry.start(); } catch (reason) { fail(reason); }
    });
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);

    /** Resolves true when extraction may continue past the soft budget. */
    const consultBudget = async () => {
      if (!budgetPromptNeeded || budgetConfirmed) return true;
      budgetPromptNeeded = false;
      const proceed = await options.onBudgetExceeded?.({
        expandedBytes,
        budgetBytes: limits.confirmExpandedBytes,
        hardLimitBytes: limits.maxTotalExpandedBytes,
      });
      if (!proceed) {
        fail(new ArchiveLimitError(
          "expansion-budget",
          `Extraction beyond the declared decompression budget (${Math.round(limits.confirmExpandedBytes / (1024 * 1024))} MB) was not confirmed.`,
          limits.confirmExpandedBytes,
          expandedBytes,
        ));
        return false;
      }
      budgetConfirmed = true;
      return true;
    };

    void (async () => {
      try {
        const reader = file.stream().getReader();
        for (;;) {
          if (settled) { await reader.cancel().catch(() => undefined); return; }
          if (!(await consultBudget())) { await reader.cancel().catch(() => undefined); return; }
          const { done, value } = await reader.read();
          if (done) break;
          compressedRead += value.byteLength;
          unzip.push(value, false);
          if (settled) { await reader.cancel().catch(() => undefined); return; }
          reportProgress();
        }
        unzip.push(new Uint8Array(0), true);
        // The final push can be what crosses the soft budget; the confirmation
        // still has to happen before the extraction is presented as complete.
        if (!(await consultBudget())) return;
        archiveEnded = true;
        finish();
      } catch (reason) {
        fail(reason);
      }
    })();
  });
}
