/**
 * Import orchestrator (S4 editor-core).
 *
 * Extracts the monolith's import pipeline (`importSelectedFiles` +
 * `arrangeArchive` + the deferred arrangement scheduling) into a React-free,
 * engine-adapter-driven module:
 *
 * - normalizes picked/dropped files (extension sniffing via archive-import),
 * - extracts ZIP archives under the declared decompression limits, passing the
 *   user-confirmation callback through (gap table §5 / T7),
 * - dispatches the resulting model files to the engine through the typed
 *   adapter (no direct shadow-root access here),
 * - plans and executes the post-import multi-plate arrangement for archives,
 *   honestly bounded by the engine's {@link PLATE_CAP}.
 *
 * All user-facing text stays in the UI layer: outcomes are reported as typed
 * notices/errors that the shell localizes.
 */

import { EngineAdapter, EngineAdapterError } from "./engine-adapter";
import {
  ArchiveLimitError,
  extractModelArchive,
  fileExtension,
  normalizeModelFile,
  type ExtractArchiveOptions,
} from "./archive-import";
import { PLATE_CAP, packModelsAcrossPlates, snapshotFootprint } from "./plate-packing";

export type ImportStage = "analyzing" | "extracting" | "arranging";

export interface ImportProgressUpdate {
  stage: ImportStage;
  /** 0..1 where measurable; 1 while waiting for the engine to arrange. */
  ratio: number;
  extractedFiles: number;
}

export type ImportNotice =
  | { kind: "imported"; fileCount: number }
  | { kind: "archive-arranged"; models: number; plates: number }
  /** Objects left at their import position — the engine supports at most PLATE_CAP plates. */
  | { kind: "archive-overflow"; count: number }
  | { kind: "archive-oversized"; count: number };

export type ImportErrorCode =
  | "empty-file"
  | "unsupported-file"
  | "no-model-files"
  | "file-too-large"
  | "engine-unavailable"
  | ArchiveLimitError["code"];

/**
 * THE BIGGEST MODEL THIS EDITOR WILL ACCEPT, AND THE MEASUREMENT BEHIND IT.
 *
 * The owner asked for 1 GB and 2 GB files. A browser cannot slice one, and no
 * amount of work in this repository changes that:
 *
 *   * the engine is wasm32. Its entire address space is 4 GiB, and that is a
 *     property of the instruction set, not a setting;
 *   * iPad Safari — the device this shop is run from — kills a tab somewhere
 *     between 1 and 1.5 GB of resident memory, well before that ceiling;
 *   * geometry does not stay the size of its file. MEASURED on this engine: a
 *     190.7 MB STL peaked at 1796 MB (9.42x) before the redundant copies were
 *     removed, and at 396 MB (2.08x) after. A 3MF is far worse — 57x — because
 *     it is compressed XML that becomes float32 vertices and int32 indices.
 *
 * 500 MB is therefore not a policy number. It is roughly the largest file
 * whose 2x working set still fits beside the kernel, the pthread pool and a
 * rendered scene on a real device.
 *
 * The owner chose to REFUSE above it rather than accept and disable slicing:
 * a customer who uploads 2 GB, waits, and is then told the thing cannot be
 * sliced has spent their time to learn what we already knew. The refusal
 * happens at SELECTION, before a single byte is read.
 */
export const MODEL_FILE_BYTES_CEILING = 500 * 1024 * 1024;

/**
 * The files too big to accept, named. Returns an empty array for a selection
 * that is entirely fine, so the caller's normal path costs one length check.
 *
 * An ARCHIVE is not measured here: a ZIP's danger is what it EXPANDS to, and
 * `archive-import.ts` already owns that with its own budget, confirmation and
 * zip-bomb ratio test. Measuring its compressed size as if it were geometry
 * would refuse a legitimate 600 MB archive of small parts and let a 40 MB one
 * that expands to 3 GB straight through.
 */
export function oversizedModelFiles(
  files: readonly File[],
  ceiling: number = MODEL_FILE_BYTES_CEILING
): File[] {
  return files.filter((file) => !/\.zip$/i.test(file.name) && file.size > ceiling);
}

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly fileName?: string;
  constructor(code: ImportErrorCode, message: string, fileName?: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.fileName = fileName;
  }
}

export interface ImportContext {
  /** Object ids present before the import (arrangement targets only new ones). */
  existingObjectIds: ReadonlySet<number>;
  plateCount: number;
  selectedPlate: number;
  bedWidth: number;
  bedDepth: number;
}

export interface ImportCallbacks {
  onProgress?: (progress: ImportProgressUpdate | null) => void;
  onNotice?: (notice: ImportNotice) => void;
  /** Forwarded to the ZIP extractor's decompression-budget confirmation. */
  onBudgetExceeded?: ExtractArchiveOptions["onBudgetExceeded"];
  archiveLimits?: ExtractArchiveOptions["limits"];
}

export interface ImportResult {
  importedFiles: File[];
  /** True when an archive arrangement is pending on the engine's objects event. */
  archivePlanned: boolean;
}

interface PendingArchivePlan {
  beforeIds: ReadonlySet<number>;
  startPlate: number;
  maxPlateCount: number;
  bedWidth: number;
  bedDepth: number;
  callbacks: ImportCallbacks;
}

/** Delay after the last objects event before arranging, letting the engine settle. */
const ARRANGE_SETTLE_MS = 260;

export class ImportOrchestrator {
  private readonly adapter: EngineAdapter;
  private importing = false;
  private pendingPlan: PendingArchivePlan | null = null;
  private arrangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: EngineAdapter) {
    this.adapter = adapter;
  }

  get busy(): boolean {
    return this.importing;
  }

  get hasPendingArrangement(): boolean {
    return this.pendingPlan !== null;
  }

  /**
   * Runs the full import pipeline. Throws {@link ImportError} (including the
   * archive-limit codes) — nothing is swallowed and no failure is presented as
   * success. On success the returned files were handed to the engine and, when
   * an archive was involved, an arrangement is pending on the next objects
   * event (`notifyObjects`).
   */
  async importFiles(rawFiles: File[], context: ImportContext, callbacks: ImportCallbacks = {}): Promise<ImportResult> {
    if (!rawFiles.length) return { importedFiles: [], archivePlanned: false };
    if (this.importing) throw new ImportError("engine-unavailable", "Another import is already running.");
    this.importing = true;
    callbacks.onProgress?.({ stage: "analyzing", ratio: 0, extractedFiles: 0 });
    try {
      const modelFiles: File[] = [];
      let hadArchive = false;
      for (const rawFile of rawFiles) {
        if (!rawFile.size) throw new ImportError("empty-file", `Empty file: ${rawFile.name}`, rawFile.name);
        let file: File;
        try {
          file = await normalizeModelFile(rawFile);
        } catch (reason) {
          throw new ImportError(
            "unsupported-file",
            reason instanceof Error ? reason.message : `Unsupported file: ${rawFile.name}`,
            rawFile.name,
          );
        }
        if (fileExtension(file.name) !== "zip") {
          modelFiles.push(file);
          continue;
        }
        hadArchive = true;
        callbacks.onProgress?.({ stage: "extracting", ratio: 0, extractedFiles: modelFiles.length });
        try {
          const extracted = await extractModelArchive(file, (archiveProgress) => {
            callbacks.onProgress?.({
              stage: "extracting",
              ratio: archiveProgress.compressedTotal
                ? archiveProgress.compressedRead / archiveProgress.compressedTotal
                : 0,
              extractedFiles: modelFiles.length + archiveProgress.extractedFiles,
            });
          }, {
            limits: callbacks.archiveLimits,
            onBudgetExceeded: callbacks.onBudgetExceeded,
          });
          modelFiles.push(...extracted);
        } catch (reason) {
          if (reason instanceof ArchiveLimitError) {
            throw new ImportError(reason.code, reason.message, file.name);
          }
          throw new ImportError(
            "unsupported-file",
            reason instanceof Error ? reason.message : `The archive could not be extracted: ${file.name}`,
            file.name,
          );
        }
      }
      if (!modelFiles.length) {
        throw new ImportError("no-model-files", "No supported model files were found in the selection.");
      }

      if (hadArchive) {
        this.pendingPlan = {
          beforeIds: new Set(context.existingObjectIds),
          startPlate: context.existingObjectIds.size
            ? (context.plateCount < PLATE_CAP ? context.plateCount : context.selectedPlate)
            : 0,
          maxPlateCount: context.existingObjectIds.size && context.plateCount >= PLATE_CAP
            ? context.selectedPlate + 1
            : PLATE_CAP,
          bedWidth: context.bedWidth,
          bedDepth: context.bedDepth,
          callbacks,
        };
        callbacks.onProgress?.({ stage: "extracting", ratio: 1, extractedFiles: modelFiles.length });
      }

      try {
        await this.adapter.dispatchFiles(modelFiles);
      } catch (reason) {
        this.clearPendingArrangement();
        if (reason instanceof EngineAdapterError) {
          throw new ImportError("engine-unavailable", reason.message);
        }
        throw reason;
      }

      if (hadArchive && !this.adapter.api()) {
        // Without the viewport API there is nothing to arrange with — say so
        // honestly instead of leaving a plan that never completes.
        this.clearPendingArrangement();
        callbacks.onNotice?.({ kind: "imported", fileCount: modelFiles.length });
        callbacks.onProgress?.(null);
        return { importedFiles: modelFiles, archivePlanned: false };
      }
      if (!hadArchive) {
        callbacks.onNotice?.({ kind: "imported", fileCount: modelFiles.length });
        callbacks.onProgress?.(null);
      }
      return { importedFiles: modelFiles, archivePlanned: hadArchive };
    } catch (reason) {
      this.clearPendingArrangement();
      callbacks.onProgress?.(null);
      throw reason;
    } finally {
      this.importing = false;
    }
  }

  /**
   * Feed the engine's `objects` events here. When a pending archive
   * arrangement exists and new objects have appeared, the arrangement runs
   * after a short settle delay (matching the monolith's behavior).
   */
  notifyObjects(objectIds: readonly number[]): void {
    const plan = this.pendingPlan;
    if (!plan) return;
    if (!objectIds.some((id) => !plan.beforeIds.has(id))) return;
    if (this.arrangeTimer !== null) clearTimeout(this.arrangeTimer);
    this.arrangeTimer = setTimeout(() => {
      this.arrangeTimer = null;
      void this.arrangePendingArchive();
    }, ARRANGE_SETTLE_MS);
  }

  /** Cancels any pending archive arrangement (new project, unmount, failure). */
  clearPendingArrangement(): void {
    this.pendingPlan = null;
    if (this.arrangeTimer !== null) {
      clearTimeout(this.arrangeTimer);
      this.arrangeTimer = null;
    }
  }

  dispose(): void {
    this.clearPendingArrangement();
  }

  private async arrangePendingArchive(): Promise<void> {
    const plan = this.pendingPlan;
    if (!plan) return;
    const api = this.adapter.api();
    if (!api) return;
    const snapshots = api.sceneSnapshot().filter((snapshot) => !plan.beforeIds.has(snapshot.id));
    if (!snapshots.length) return;
    this.pendingPlan = null;
    const { callbacks } = plan;
    callbacks.onProgress?.({ stage: "arranging", ratio: 1, extractedFiles: snapshots.length });
    const packing = packModelsAcrossPlates(
      snapshots.map(snapshotFootprint),
      plan.bedWidth,
      plan.bedDepth,
      plan.startPlate,
      plan.maxPlateCount,
    );
    await this.adapter.ensurePlateCount(Math.max(
      this.adapter.currentPlateCount(),
      plan.startPlate + packing.platesUsed,
    ));
    for (const placement of packing.placements) {
      api.placeObjectOnPlate(placement.id, placement.plate, placement.offsetX, placement.offsetY);
    }
    this.adapter.selectPlate(plan.startPlate);
    api.frame();
    if (packing.placements.length) this.adapter.notifySceneEdited();
    callbacks.onNotice?.({ kind: "archive-arranged", models: snapshots.length, plates: packing.platesUsed });
    if (packing.oversizedCount) callbacks.onNotice?.({ kind: "archive-oversized", count: packing.oversizedCount });
    if (packing.overflowCount) callbacks.onNotice?.({ kind: "archive-overflow", count: packing.overflowCount });
    callbacks.onProgress?.(null);
  }
}

export function createImportOrchestrator(adapter: EngineAdapter): ImportOrchestrator {
  return new ImportOrchestrator(adapter);
}
