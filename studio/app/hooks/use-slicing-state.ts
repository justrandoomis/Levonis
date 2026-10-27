/**
 * Slicing-state hook with stale-result invalidation (S4 editor-core).
 *
 * Closes the gap table's biggest §8 gap ("حماية النتائج القديمة"): in the
 * monolith, moving/rotating/scaling/painting AFTER a slice left the old
 * G-code downloadable as if it were fresh. This hook:
 *
 * - stores per-plate slice results OUTSIDE React state (a module map keyed by
 *   a per-hook symbol — the same pattern as the monolith's GCODE_ARTIFACTS),
 * - fingerprints the scene at slice START (adapter.sceneFingerprint) and
 *   tracks a settings revision, so any geometry/transform/extruder edit or
 *   settings/material change afterwards makes stored results STALE,
 * - refuses to hand out stale G-code through `freshGcodeFile` — the export
 *   paths must use it; `staleGcodeFile` exists only for explicitly-labeled use,
 * - never stores an over_bed result as exportable output (§1 build-volume row:
 *   a result that exceeds the build volume is rejected, not archived).
 *
 * Scene-edit signals are event-driven: the adapter's gesture listeners (and
 * every keyup on the window, where the engine's key shortcuts listen) plus
 * the engine's `objects`/`extruderColors`/`plateCount` events. No polling.
 * They only make the banner render again: freshness itself is judged on the
 * scene read at the moment of asking (resultMatches), so an edit whose
 * signal has not come yet still makes the result stale at export time.
 *
 * MEMORY. A plate's G-code is kept as a Blob, never as a JS string. The
 * difference is not cosmetic: a real plate is tens of megabytes of text, the
 * engine already holds its own copy behind a blob: URL, and up to nine plates
 * can have a stored result at once. Holding those as strings puts hundreds of
 * megabytes on the main thread's JS heap — and on a phone the JS heap and the
 * slice worker share one per-tab budget, so the thing that dies is the worker,
 * reported as "Worker terminated (likely out of memory)". A Blob keeps the
 * bytes in blob storage instead, where they can be paged out, and every
 * consumer here wanted a File anyway (download, share, LAN print).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter } from "../engine-adapter";

export interface SliceStats {
  layers?: number;
  filament_mm?: number;
  time_estimate?: number;
  path_segments?: number;
  over_bed?: boolean;
  over_bed_model?: boolean;
  [key: string]: unknown;
}

export interface SlicePayload {
  plate: number;
  stats: SliceStats;
  gcode: string;
}

/** MIME type every G-code File this hook hands out carries. */
export const GCODE_MIME = "text/x-gcode";

/** The subset of the engine's ViewportEvent stream this hook consumes. */
export type SlicingViewportEvent =
  | { type: "slicing"; value: boolean }
  | { type: "progress"; value: number }
  | { type: "layerCount"; value: number }
  | { type: "objects"; value: Array<{ id: number; name: string; extruder: number; visible: boolean }> }
  | { type: "extruderColors"; value: string[] }
  | { type: "plateCount"; value: number }
  | { type: string; value: unknown };

export type PlateResultState = "none" | "fresh" | "stale" | "rejected-over-bed";

export interface SliceOutcome {
  /** False when the result was rejected (over_bed) and NOT stored. */
  stored: boolean;
  overBed: boolean;
  plate: number;
}

interface StoredSliceResult {
  /** The G-code bytes, off the JS heap. See the MEMORY note in the header. */
  gcode: Blob;
  /** Byte length, so callers can report size without reading the Blob back. */
  bytes: number;
  stats: SliceStats;
  /** Scene fingerprint captured when the producing slice run started. */
  sceneFingerprint: string;
  settingsRevision: number;
  completedAt: number;
}

/**
 * A plate whose last result the engine rejected as over the bed, and the
 * scene and settings that rejection was about.
 */
interface RejectedSlice {
  sceneFingerprint: string;
  settingsRevision: number;
}

/**
 * WHETHER AN OVER-BED REJECTION STILL DESCRIBES THE PLATE.
 *
 * A rejection is a verdict on one scene under one set of settings. It used to
 * outlive both: after «ترتيب» put the model back on the bed (the very action
 * the banner recommends), the plate still read "rejected-over-bed" and the
 * banner kept saying «خارج حدود سطح الطباعة» until the next slice. Once the
 * scene or the settings have moved on, the rejection says nothing about the
 * plate any more: it reads as no result, and the before-slice placement check
 * (objectsOffBed) decides whether the plate is blocked. The same rule as a
 * stored result going stale, minus the result.
 */
export function rejectionHolds(
  rejected: RejectedSlice,
  live: { sceneFingerprint: string; settingsRevision: number },
): boolean {
  return rejected.sceneFingerprint === live.sceneFingerprint && rejected.settingsRevision === live.settingsRevision;
}

/**
 * WHETHER A STORED RESULT STILL DESCRIBES THE PLATE, JUDGED ON THE SCENE AS
 * IT IS AT THE MOMENT OF ASKING (c6fix-r2-ha-01).
 *
 * The fingerprint kept in React state follows the adapter's edit signals, and
 * a signal can be missing: the engine nudges the selected model on a keydown
 * anywhere on the page, and while a key is held its keyup has not come yet.
 * So the result is compared with the scene read now (`live.sceneFingerprint`,
 * from adapter.sceneFingerprint()); the state only makes the banner render
 * again. Null means there is no engine to read, and only the settings count.
 */
export function resultMatches(
  stored: { sceneFingerprint: string; settingsRevision: number },
  live: { sceneFingerprint: string | null; settingsRevision: number },
): boolean {
  return stored.settingsRevision === live.settingsRevision
    && (live.sceneFingerprint === null || stored.sceneFingerprint === live.sceneFingerprint);
}

/** G-code stays out of React state: results live here, keyed per hook instance. */
const SLICE_RESULTS = new Map<symbol, Map<number, StoredSliceResult>>();
const OVER_BED_PLATES = new Map<symbol, Map<number, RejectedSlice>>();

/** How often (at most) progress updates re-render, matching the monolith. */
const PROGRESS_THROTTLE_MS = 160;

export interface SlicingStateApi {
  slicing: boolean;
  /** 0..1, throttled. */
  progress: number;
  layerCount: number;
  /** State of the stored result for a plate. */
  resultState: (plate: number) => PlateResultState;
  /**
   * G-code for a plate as a named File, ONLY while it still matches the
   * current scene and settings. Returns null for stale, rejected, or missing
   * results — export, share and print paths must use this accessor.
   */
  freshGcodeFile: (plate: number, fileName: string) => File | null;
  /**
   * Stale or fresh G-code, for callers that explicitly present it as an old
   * result (e.g. a preview labeled "outdated"). Never silently exportable.
   */
  staleGcodeFile: (plate: number, fileName: string) => File | null;
  /** Stored G-code size in bytes for a plate (0 when there is no result). */
  gcodeBytes: (plate: number) => number;
  stats: (plate: number) => SliceStats | null;
  /** Plates with a stored (fresh or stale) result. */
  storedPlateCount: number;
  /** True when at least one stored result is fresh. */
  anyFresh: boolean;
  /** True when at least one stored result went stale after edits. */
  anyStale: boolean;
  /**
   * Which rung of the engine's three-attempt retry ladder is running, 1-based;
   * 1 while the first (and usually only) attempt is in flight.
   *
   * A slice that fails is retried twice — classic walls, then economy — with a
   * worker termination and a 5.2 MB kernel re-boot between rungs, and the
   * engine used to report none of it. The owner's description of that silence
   * was «بعد فترة كبيرة من الانتظار يظهر فشل». Surfacing the rung is what
   * turns those minutes from a frozen bar into visible progress.
   *
   * It keeps its last value after the slice ends, so a failure message can say
   * how many attempts were spent, and resets when the next slice starts.
   */
  retryAttempt: number;
  /** How many attempts the ladder has in total (3 on the patched engine). */
  retryTotal: number;
  /** Feed every engine ViewportEvent here (in addition to the shell's handling). */
  handleViewportEvent: (event: SlicingViewportEvent) => void;
  /** Feed the engine's onSliced payload here. */
  handleSliced: (payload: SlicePayload) => SliceOutcome;
  /** Any settings/material/preset change must call this (marks results stale). */
  notifySettingsChanged: () => void;
  /** Drops every stored result (new project, profile switch, resume). */
  clearResults: () => void;
}

export function useSlicingState(adapter: EngineAdapter | null): SlicingStateApi {
  const [instanceId] = useState(() => Symbol("levo-slice-results"));
  const [slicing, setSlicing] = useState(false);
  const [retry, setRetry] = useState<{ attempt: number; total: number }>({ attempt: 1, total: 1 });
  const [progress, setProgress] = useState(0);
  const [layerCount, setLayerCount] = useState(0);
  const [sceneFingerprint, setSceneFingerprint] = useState("");
  const [settingsRevision, setSettingsRevision] = useState(0);
  // Bumped whenever the stored-result maps change, so reads re-render.
  const [resultsVersion, setResultsVersion] = useState(0);

  const settingsRevisionRef = useRef(0);
  const sliceStartFingerprintRef = useRef<string | null>(null);
  const sliceStartSettingsRevisionRef = useRef(0);
  const pendingProgressRef = useRef(0);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adapterRef = useRef<EngineAdapter | null>(adapter);
  adapterRef.current = adapter;

  const results = useCallback((): Map<number, StoredSliceResult> => {
    let map = SLICE_RESULTS.get(instanceId);
    if (!map) {
      map = new Map();
      SLICE_RESULTS.set(instanceId, map);
    }
    return map;
  }, [instanceId]);

  const overBedPlates = useCallback((): Map<number, RejectedSlice> => {
    let map = OVER_BED_PLATES.get(instanceId);
    if (!map) {
      map = new Map();
      OVER_BED_PLATES.set(instanceId, map);
    }
    return map;
  }, [instanceId]);

  useEffect(() => () => {
    SLICE_RESULTS.delete(instanceId);
    OVER_BED_PLATES.delete(instanceId);
    if (progressTimerRef.current !== null) clearTimeout(progressTimerRef.current);
  }, [instanceId]);

  const refreshSceneFingerprint = useCallback(() => {
    const current = adapterRef.current;
    if (!current) return;
    setSceneFingerprint(current.sceneFingerprint());
  }, []);

  // Event-driven staleness: the adapter reports candidate scene edits (gesture
  // endings and programmatic mutations); the fingerprint decides whether the
  // printable scene actually changed.
  useEffect(() => {
    if (!adapter) return;
    refreshSceneFingerprint();
    return adapter.onSceneEdit(refreshSceneFingerprint);
  }, [adapter, refreshSceneFingerprint]);

  /** The scene read now, or null when there is no engine adapter to read. */
  const liveFingerprint = useCallback((): string | null => adapterRef.current?.sceneFingerprint() ?? null, []);

  // `sceneFingerprint` is not read here: the scene is (resultMatches). It is
  // a dependency so that every reader derives again when an edit lands.
  const isFresh = useCallback((result: StoredSliceResult) => resultMatches(result, {
    sceneFingerprint: liveFingerprint(),
    settingsRevision: settingsRevisionRef.current,
  }), [liveFingerprint, sceneFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  const resultState = useCallback<SlicingStateApi["resultState"]>((plate) => {
    const rejected = overBedPlates().get(plate);
    if (rejected && rejectionHolds(rejected, {
      sceneFingerprint: liveFingerprint() ?? rejected.sceneFingerprint,
      settingsRevision: settingsRevisionRef.current,
    })) return "rejected-over-bed";
    const stored = results().get(plate);
    if (!stored) return "none";
    return isFresh(stored) ? "fresh" : "stale";
  }, [isFresh, liveFingerprint, overBedPlates, results]);

  const freshGcodeFile = useCallback<SlicingStateApi["freshGcodeFile"]>((plate, fileName) => {
    // At export time the scene is read again. When it moved without an edit
    // signal (a key still held), the state catches up here, so the banner
    // and the G-code tile say «stale» at once, and nothing is handed out.
    const live = liveFingerprint();
    if (live !== null && live !== sceneFingerprint) setSceneFingerprint(live);
    const stored = results().get(plate);
    if (!stored || !isFresh(stored)) return null;
    return new File([stored.gcode], fileName, { type: GCODE_MIME });
  }, [isFresh, liveFingerprint, results, sceneFingerprint]);

  const staleGcodeFile = useCallback<SlicingStateApi["staleGcodeFile"]>((plate, fileName) => {
    const stored = results().get(plate);
    if (!stored) return null;
    return new File([stored.gcode], fileName, { type: GCODE_MIME });
  }, [results]);

  const gcodeBytes = useCallback<SlicingStateApi["gcodeBytes"]>((plate) => (
    results().get(plate)?.bytes ?? 0
  ), [results]);

  const stats = useCallback<SlicingStateApi["stats"]>((plate) => (
    results().get(plate)?.stats ?? null
  ), [results]);

  const handleSliced = useCallback<SlicingStateApi["handleSliced"]>((payload) => {
    const overBed = Boolean(payload.stats.over_bed || payload.stats.over_bed_model);
    const currentFingerprint = adapterRef.current?.sceneFingerprint() ?? "";
    if (overBed) {
      // Never store an out-of-volume result as exportable output. Remember
      // what was rejected (the scene as the run saw it, see below) so that
      // an edit afterwards retires the verdict (rejectionHolds).
      results().delete(payload.plate);
      overBedPlates().set(payload.plate, {
        sceneFingerprint: sliceStartFingerprintRef.current ?? currentFingerprint,
        settingsRevision: sliceStartSettingsRevisionRef.current,
      });
      setSceneFingerprint(currentFingerprint);
      setResultsVersion((value) => value + 1);
      return { stored: false, overBed: true, plate: payload.plate };
    }
    overBedPlates().delete(payload.plate);
    // The payload string becomes garbage the moment this returns; only the
    // Blob is retained. See the MEMORY note at the top of this file.
    const gcode = new Blob([payload.gcode], { type: GCODE_MIME });
    results().set(payload.plate, {
      gcode,
      bytes: gcode.size,
      stats: payload.stats,
      // The scene as the slice run saw it: the fingerprint captured when the
      // run started. If edits happened mid-slice the start fingerprint no
      // longer matches the live scene and the result is immediately stale —
      // which is exactly right.
      sceneFingerprint: sliceStartFingerprintRef.current ?? currentFingerprint,
      settingsRevision: sliceStartSettingsRevisionRef.current,
      completedAt: Date.now(),
    });
    setSceneFingerprint(currentFingerprint);
    setResultsVersion((value) => value + 1);
    return { stored: true, overBed: false, plate: payload.plate };
  }, [overBedPlates, results]);

  const handleViewportEvent = useCallback<SlicingStateApi["handleViewportEvent"]>((event) => {
    if (event.type === "slicing" && typeof event.value === "boolean") {
      if (event.value) {
        sliceStartFingerprintRef.current = adapterRef.current?.sceneFingerprint() ?? "";
        sliceStartSettingsRevisionRef.current = settingsRevisionRef.current;
        // The engine raises `slicing: true` ONCE for the whole ladder, not per
        // rung, so this is the only place the counter may be reset — doing it
        // on `false` would erase the count a failure message needs.
        setRetry({ attempt: 1, total: 1 });
      } else {
        sliceStartFingerprintRef.current = null;
        setProgress(0);
      }
      setSlicing(event.value);
    } else if (event.type === "progress" && typeof event.value === "number") {
      pendingProgressRef.current = Math.max(0, Math.min(1, event.value));
      if (progressTimerRef.current === null) {
        progressTimerRef.current = setTimeout(() => {
          progressTimerRef.current = null;
          setProgress(pendingProgressRef.current);
        }, PROGRESS_THROTTLE_MS);
      }
    } else if (event.type === "layerCount" && typeof event.value === "number") {
      setLayerCount(event.value);
    } else if (event.type === "objects" || event.type === "extruderColors") {
      // Geometry membership / per-object extruder / material color changes:
      // re-fingerprint (extruder assignment is part of the fingerprint). A
      // color-mapping change alone bumps the settings revision — filament
      // color mapping reaches multi-material output.
      if (event.type === "extruderColors") {
        settingsRevisionRef.current += 1;
        setSettingsRevision(settingsRevisionRef.current);
      }
      refreshSceneFingerprint();
    } else if (event.type === "plateCount" && typeof event.value === "number") {
      // Results for plates that no longer exist are dropped, not kept around.
      const map = results();
      let dropped = false;
      for (const plate of [...map.keys()]) {
        if (plate >= event.value) {
          map.delete(plate);
          dropped = true;
        }
      }
      const rejected = overBedPlates();
      for (const plate of [...rejected.keys()]) {
        if (plate >= event.value) {
          rejected.delete(plate);
          dropped = true;
        }
      }
      if (dropped) setResultsVersion((value) => value + 1);
    }
  }, [overBedPlates, refreshSceneFingerprint, results]);

  const notifySettingsChanged = useCallback(() => {
    settingsRevisionRef.current += 1;
    setSettingsRevision(settingsRevisionRef.current);
  }, []);

  const clearResults = useCallback(() => {
    results().clear();
    overBedPlates().clear();
    sliceStartFingerprintRef.current = null;
    setLayerCount(0);
    setProgress(0);
    setResultsVersion((value) => value + 1);
  }, [overBedPlates, results]);

  /**
   * THE RETRY LADDER, SUBSCRIBED.
   *
   * `patches/three-slicer+0.2.2.patch` makes the engine announce each failed
   * attempt; the adapter turns that into `onSliceRetry`. An unpatched build
   * never fires, so `retry` simply stays at 1/1 and the UI shows what it
   * always did — the subscription cannot invent a retry that did not happen.
   *
   * `event.index` is the attempt that just FAILED, so the one now starting is
   * `index + 1`. It is clamped to `total` because the last rung's failure is
   * the end of the ladder, not the start of a fourth attempt.
   */
  useEffect(() => {
    if (!adapter) return;
    return adapter.onSliceRetry((event) => {
      setRetry({ attempt: Math.min(event.index + 1, event.total), total: event.total });
    });
  }, [adapter]);

  const { storedPlateCount, anyFresh, anyStale } = useMemo(() => {
    const map = results();
    let fresh = 0;
    let stale = 0;
    for (const stored of map.values()) {
      if (isFresh(stored)) fresh += 1;
      else stale += 1;
    }
    return { storedPlateCount: map.size, anyFresh: fresh > 0, anyStale: stale > 0 };
    // resultsVersion/settingsRevision/sceneFingerprint are the external inputs
    // of this derivation (the maps live outside React state).
  }, [isFresh, results, resultsVersion, settingsRevision, sceneFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    slicing,
    progress,
    layerCount,
    retryAttempt: retry.attempt,
    retryTotal: retry.total,
    resultState,
    freshGcodeFile,
    staleGcodeFile,
    gcodeBytes,
    stats,
    storedPlateCount,
    anyFresh,
    anyStale,
    handleViewportEvent,
    handleSliced,
    notifySettingsChanged,
    clearResults,
  };
}
