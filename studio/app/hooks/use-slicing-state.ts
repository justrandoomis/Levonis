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
 * - refuses to hand out stale G-code through `freshGcode` — the export paths
 *   must use it; `staleGcode` exists only for explicitly-labeled use,
 * - never stores an over_bed result as exportable output (§1 build-volume row:
 *   a result that exceeds the build volume is rejected, not archived).
 *
 * Scene-edit signals are event-driven: the adapter's gesture listeners plus
 * the engine's `objects`/`extruderColors`/`plateCount` events. No polling.
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
  gcode: string;
  stats: SliceStats;
  /** Scene fingerprint captured when the producing slice run started. */
  sceneFingerprint: string;
  settingsRevision: number;
  completedAt: number;
}

/** G-code stays out of React state: results live here, keyed per hook instance. */
const SLICE_RESULTS = new Map<symbol, Map<number, StoredSliceResult>>();
const OVER_BED_PLATES = new Map<symbol, Set<number>>();

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
   * G-code for a plate ONLY while it still matches the current scene and
   * settings. Returns null for stale, rejected, or missing results — export
   * and share paths must use this accessor.
   */
  freshGcode: (plate: number) => string | null;
  /**
   * Stale or fresh G-code, for callers that explicitly present it as an old
   * result (e.g. a preview labeled "outdated"). Never silently exportable.
   */
  staleGcode: (plate: number) => string | null;
  stats: (plate: number) => SliceStats | null;
  /** Plates with a stored (fresh or stale) result. */
  storedPlateCount: number;
  /** True when at least one stored result is fresh. */
  anyFresh: boolean;
  /** True when at least one stored result went stale after edits. */
  anyStale: boolean;
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

  const overBedPlates = useCallback((): Set<number> => {
    let set = OVER_BED_PLATES.get(instanceId);
    if (!set) {
      set = new Set();
      OVER_BED_PLATES.set(instanceId, set);
    }
    return set;
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

  const isFresh = useCallback((result: StoredSliceResult) => (
    result.settingsRevision === settingsRevisionRef.current
    && result.sceneFingerprint === (adapterRef.current ? sceneFingerprint : result.sceneFingerprint)
  ), [sceneFingerprint]);

  const resultState = useCallback<SlicingStateApi["resultState"]>((plate) => {
    if (overBedPlates().has(plate)) return "rejected-over-bed";
    const stored = results().get(plate);
    if (!stored) return "none";
    return isFresh(stored) ? "fresh" : "stale";
  }, [isFresh, overBedPlates, results]);

  const freshGcode = useCallback<SlicingStateApi["freshGcode"]>((plate) => {
    const stored = results().get(plate);
    if (!stored || !isFresh(stored)) return null;
    return stored.gcode;
  }, [isFresh, results]);

  const staleGcode = useCallback<SlicingStateApi["staleGcode"]>((plate) => (
    results().get(plate)?.gcode ?? null
  ), [results]);

  const stats = useCallback<SlicingStateApi["stats"]>((plate) => (
    results().get(plate)?.stats ?? null
  ), [results]);

  const handleSliced = useCallback<SlicingStateApi["handleSliced"]>((payload) => {
    const overBed = Boolean(payload.stats.over_bed || payload.stats.over_bed_model);
    if (overBed) {
      // Never store an out-of-volume result as exportable output.
      results().delete(payload.plate);
      overBedPlates().add(payload.plate);
      setResultsVersion((value) => value + 1);
      return { stored: false, overBed: true, plate: payload.plate };
    }
    overBedPlates().delete(payload.plate);
    const currentFingerprint = adapterRef.current?.sceneFingerprint() ?? "";
    results().set(payload.plate, {
      gcode: payload.gcode,
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
      for (const plate of [...rejected]) {
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
    resultState,
    freshGcode,
    staleGcode,
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
