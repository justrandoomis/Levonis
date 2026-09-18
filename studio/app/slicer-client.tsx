"use client";

/**
 * LEVO Studio editor shell (slice S6 integration round).
 *
 * The former monolith, now composed from the fleet's owned modules:
 * - engine access goes through the S4 typed adapter (engine-adapter.ts):
 *   shadow-root discovery, theme injection, testid clicks, shortcuts, file
 *   dispatch and __vpApi — no inline DOM automation remains here;
 * - import runs through the S4 orchestrator (ZIP budgets + archive
 *   arrangement), slicing honesty through the S4 use-slicing-state hook
 *   (stale-result invalidation, over-bed rejection, per-plate freshness);
 * - printer data/preset loading come from printer-profiles.ts /
 *   profile-loader.ts with an explicit missing-preset warning (no silent
 *   fallback presented as "verified");
 * - UI chrome is split into components/header.tsx and components/sheets/*;
 * - i18n: ar (default) / en / reviewed-pending ckb from app/i18n, RTL chrome
 *   with an always-LTR viewport, locale persisted;
 * - LEVONIS identity: editor-theme.ts tokens are injected into the engine's
 *   shadow surfaces by the adapter (EDITOR_SHADOW_CSS);
 * - APK/update-check UI removed from the web (mandate §12): no download link
 *   anywhere, native update wiring dropped; native printer bridges stay in
 *   the tree but remain capability-gated and unreachable on the web.
 *
 * The engine settings flow is unchanged: one settings object drives the
 * Viewport and the engine's SettingsPanel (SettingsBook), machine keys stay
 * locked to the loaded machine preset.
 */

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlicerSettings } from "three-slicer";
import type { SettingsPanelProps } from "three-slicer/components";
import { uiTree } from "three-slicer/data";
import type { ViewportEvent, ViewportProps } from "three-slicer/viewer";
import { registerExtendedModelLoaders } from "./model-loaders";
import {
  arrangeCurrentObjects, autoOrientObjects, createEngineAdapter, cutObject, cutRange, seatNewObjects,
  type CutKeep, type EngineTestId,
} from "./engine-adapter";
import { currentDeviceProfile } from "./device-profile";
import { createImportOrchestrator, ImportError, type ImportNotice, type ImportProgressUpdate } from "./import-orchestrator";
import { useSlicingState, type SlicePayload, type SlicingViewportEvent } from "./hooks/use-slicing-state";
import { EDITOR_SHADOW_CSS } from "./editor-theme";
import { fallbackMachineSettings, loadPrinterProfile, type MissingPreset } from "./profile-loader";
import { applyMachineLock } from "./machine-lock";
import { carryUserEdits, changedKeys, type PresetSelection } from "./settings-carryover";
import {
  DEFAULT_PROFILE_ID,
  PROFILES,
  QUALITY,
  STRENGTH,
  isProfileId,
  type ProfileId,
  type QualityId,
  type StrengthId,
} from "./printer-profiles";
import {
  connectNativePrinter,
  detectNativePrinterEnvironment,
  discoverNativePrinters,
  disconnectNativePrinter,
  getNativePrinterStatus,
  sendNativePrintJob,
  sha256Hex,
  type LevoDiscoveredPrinter,
  type LevoNativeEnvironment,
  type LevoPrinterStatus,
} from "./native-printer-bridge";
import {
  resolveSnapshotKind,
  type SnapshotKind,
  type StoredLevoProject,
} from "./project-store";
import { useProjectPersistence } from "./hooks/use-project-persistence";
import ProjectsPanel from "./components/projects-panel";
import { captureEngineThumbnail } from "./thumbnail";

/**
 * How the exported project names its producer.
 *
 * Honest by construction: LEVO Studio wrote the file, so LEVO Studio is what
 * the file says. BambuStudio decides a 3MF is its own from an `Application`
 * value starting with "BambuStudio-" (bbs_3mf.cpp:4234) — claiming that here
 * would be a false statement of origin made to pass someone else's check, so
 * it is not done, and tests/bambu-project-3mf.test.mjs fails if it ever is.
 */
const LEVO_VERSION = "1.0.0";
const LEVO_APPLICATION = `LEVO Studio-${LEVO_VERSION}`;
import type {
  OpenedRemoteProject,
  ProjectManifest,
  RemoteProjectSummary,
  SnapshotCapture,
} from "./project-sync";
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALES,
  LOCALE_NAMES,
  applyLocaleToDocument,
  dateLocaleFor,
  readStoredLocale,
  storeLocale,
  templateText,
  type Locale,
} from "./i18n";
import StudioHeader, { FileSelectControl, Icon, SIGN_IN_HREF } from "./components/header";
import SetupSheet from "./components/sheets/setup";
import PrintSheet from "./components/sheets/print";
import ConnectSheet, { type LanAction } from "./components/sheets/connect";
import AboutSheet from "./components/sheets/about";
import CutSheet from "./components/sheets/cut";

type Sheet = "setup" | "projects" | "print" | "connect" | "about" | "cut" | null;
type EditorStatus = "loading" | "editing" | "slicing" | "ready" | "error";
type CanvasMode = "prepare" | "preview";

interface ImportProgressState {
  label: string;
  ratio: number;
  extracted: number;
}

interface ProfileLoadState {
  verified: boolean;
  missingPresets: MissingPreset[];
}

const EDITOR_PANELS = {
  topBar: true,
  gizmoRail: true,
  objectToolbar: true,
  paintPanel: true,
  statsCard: true,
  plateBar: true,
  emptyHint: true,
  status: true,
  sidebar: true,
  printerCard: "readonly",
  filamentCard: true,
  objectList: true,
  previewControls: true,
  processCard: true,
  sliceBar: true,
  towerCard: true,
  resinCard: false,
  bedWarn: true,
} as unknown as NonNullable<ViewportProps["panels"]>;

/**
 * Viewport props that never change, hoisted out of the render.
 *
 * They used to be object and array literals written inline in JSX, so every
 * one of the shell's renders handed the engine a new `features`, a new
 * `defaultExtruderColors` and a new `onSliced`. The shell re-renders several
 * times a second while a slice runs (throttled progress) and on every engine
 * `objects` event, and each of those was a fresh identity for props the engine
 * has no reason to re-read. Constants cost nothing and remove that entirely.
 */
const EXTRUDER_COLORS = ["#303438", "#f3f4f4", "#BAA369", "#3a8dff"];

/**
 * Load the WASM kernel at mount (`warmup: true`) or leave it until something
 * actually slices (`warmup: false`).
 *
 * This is the single most expensive decision on the page. The engine's warmup
 * message loads `slicer_core.mt.js`, which reserves a 4 GiB SHARED
 * WebAssembly.Memory and spawns one extra Worker per logical core, compiling
 * the 5 MB module into every one of them before it reports ready — all of it
 * for a bed with nothing on it. That is the crash the owner photographed on a
 * project with nothing loaded. See app/device-profile.ts for the engine source
 * this is read from.
 *
 * Nothing is disabled either way: a constrained device loads the identical
 * kernel the moment the user slices. `warmup` is the engine's own documented
 * opt-out for exactly this ("Off, nothing is downloaded or compiled until
 * something actually slices").
 */
const EDITOR_FEATURES_WARM = { warmup: true, logs: false } as const;
const EDITOR_FEATURES_COLD = { warmup: false, logs: false } as const;

function SettingsBook({
  Panel,
  builder,
  settings,
  setSettings,
}: {
  Panel: React.ComponentType<SettingsPanelProps>;
  builder: string;
  settings: SlicerSettings;
  setSettings: Dispatch<SetStateAction<SlicerSettings>>;
}) {
  const pages = uiTree[builder] ?? [];
  // React DOM has no `defaultOpen` for <details> (the monolith's attribute was
  // silently dropped) — open state is tracked explicitly instead.
  const [openPages, setOpenPages] = useState<Set<number>>(() => new Set([0]));
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set([0]));
  return <div className="settings-book">{pages.map((page, index) => (
    <details
      key={`${builder}:${page.page}:${index}`}
      open={openPages.has(index)}
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        setOpenPages((current) => {
          if (current.has(index) === isOpen) return current;
          const next = new Set(current);
          if (isOpen) next.add(index);
          else next.delete(index);
          return next;
        });
        if (isOpen) setLoadedPages((current) => current.has(index) ? current : new Set(current).add(index));
      }}
    >
      <summary>{page.page}</summary>
      {loadedPages.has(index) && <Panel settings={settings} setSettings={setSettings} embedded only={{ builder, page: page.page }} />}
    </details>
  ))}</div>;
}

function nextFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const MB = 1024 * 1024;

/**
 * The three locales, as a segmented control rather than a native <select>.
 *
 * Three fixed choices are exactly what a segmented control is for, and on a
 * phone it needs no picker sheet — which matters because this is the copy a
 * 320px screen can reach. The autonyms are the same ones the header's select
 * shows, imported rather than restated.
 */
const LOCALE_OPTIONS = LOCALES.map((id) => ({ id, label: LOCALE_NAMES[id] }));

export default function SlicerClient({ user = null }: { user?: { id?: string; displayName: string } | null }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [sheet, setSheet] = useState<Sheet>(null);
  /**
   * How far the open sheet has been dragged down, in pixels, while a finger is
   * on the handle. 0 means "not being dragged", which is also the resting
   * state — so the inline transform is only applied while it is non-zero and
   * the CSS transition owns every other movement.
   */
  const [sheetDrag, setSheetDrag] = useState(0);
  const sheetRef = useRef<HTMLElement | null>(null);
  const [profileId, setProfileId] = useState<ProfileId>(DEFAULT_PROFILE_ID);
  const [quality, setQuality] = useState<QualityId>("standard");
  const [strength, setStrength] = useState<StrengthId>("standard");
  const [support, setSupport] = useState(false);
  // Fallback machine numbers until the async preset load resolves; the honest
  // verified/missing state comes from profileLoadState, never from this seed.
  const [settings, setSettings] = useState<SlicerSettings>(() => fallbackMachineSettings(PROFILES[DEFAULT_PROFILE_ID]));
  const [loadedPresetKey, setLoadedPresetKey] = useState("");
  const [profileLoadState, setProfileLoadState] = useState<ProfileLoadState | null>(null);
  const [status, setStatus] = useState<EditorStatus>("loading");
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("prepare");
  const [objects, setObjects] = useState<Array<{ id: number; name: string; extruder: number; visible: boolean }>>([]);
  const [plateCount, setPlateCount] = useState(1);
  const [selectedPlate, setSelectedPlate] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolTrayOpen, setToolTrayOpen] = useState(false);
  const [handyProjectReady, setHandyProjectReady] = useState(false);
  const [arrangeUndoAvailable, setArrangeUndoAvailable] = useState(false);
  const [orientUndoAvailable, setOrientUndoAvailable] = useState(false);
  const [orienting, setOrienting] = useState(false);
  const [cutUndoAvailable, setCutUndoAvailable] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [cutOffset, setCutOffset] = useState(0);
  const [cutBounds, setCutBounds] = useState({ min: 0, max: 0 });
  const [cutKeep, setCutKeep] = useState<CutKeep>("both");
  const [cutCap, setCutCap] = useState(true);
  const [nativeEnvironment, setNativeEnvironment] = useState<LevoNativeEnvironment>({
    native: false,
    platform: "web",
    bridgeVersion: null,
    capabilities: {
      discovery: false,
      lanConnection: false,
      telemetry: false,
      rawGcodePrintJob: false,
      packagePrintJob: false,
      fileTransfer: false,
      startPrint: false,
    },
  });
  const [lanAction, setLanAction] = useState<LanAction>("idle");
  const [lanIp, setLanIp] = useState("");
  const [lanAccessCode, setLanAccessCode] = useState("");
  const [lanSerial, setLanSerial] = useState("");
  const [discoveredPrinters, setDiscoveredPrinters] = useState<LevoDiscoveredPrinter[]>([]);
  const [printerStatus, setPrinterStatus] = useState<LevoPrinterStatus>({ connected: false });
  const [lanMessage, setLanMessage] = useState("");
  const [lanTransferProgress, setLanTransferProgress] = useState(0);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [projectId, setProjectId] = useState(() => crypto.randomUUID());
  const [projectName, setProjectName] = useState("LEVO Project");
  const [lastAutosavedAt, setLastAutosavedAt] = useState<number | null>(null);
  const [lastSavedKind, setLastSavedKind] = useState<SnapshotKind | null>(null);
  const [Viewport, setViewport] = useState<React.ComponentType<ViewportProps> | null>(null);
  const [SettingsPanel, setSettingsPanel] = useState<React.ComponentType<SettingsPanelProps> | null>(null);

  const viewportMountRef = useRef<HTMLDivElement>(null);
  const profileRequestRef = useRef(0);
  const exportIntentRef = useRef<"bambu-handy" | "bambu-project" | "persist" | null>(null);
  const snapshotResolverRef = useRef<((file: File | null) => void) | null>(null);
  const exportIntentTimerRef = useRef<number | null>(null);
  const suppressNextExportNoticeRef = useRef(false);
  const restoredSettingsRef = useRef<{ key: string; settings: SlicerSettings } | null>(null);
  const machineRef = useRef<SlicerSettings>(fallbackMachineSettings(PROFILES[DEFAULT_PROFILE_ID]));
  /**
   * The keys the user changed by hand since the last preset load, and the
   * selection that load was for. Together they are what lets a Support toggle
   * stop discarding a hand-tuned infill — see app/settings-carryover.ts.
   *
   * Refs rather than state: nothing renders from them, and a settings write
   * must not cost a render just to record that it happened.
   */
  const userEditedKeysRef = useRef<Set<string>>(new Set());
  const loadedSelectionRef = useRef<PresetSelection | null>(null);
  /** The live settings map, for the preset effect's async continuation. */
  const settingsRef = useRef<SlicerSettings>(settings);
  const projectFilesRef = useRef<File[]>([]);
  const arrangeUndoRef = useRef<(() => boolean) | null>(null);
  const orientUndoRef = useRef<(() => boolean) | null>(null);
  const cutUndoRef = useRef<(() => boolean) | null>(null);
  const plateCountRef = useRef(1);
  const selectedPlateRef = useRef(0);
  /** Object ids currently in the scene, so the shell can tell a spawn from a split. */
  const seenObjectIdsRef = useRef<Set<number>>(new Set());
  /**
   * Every id this session has EVER seen. The engine hands out object ids from
   * a counter that only increases, so an id that comes back is an object being
   * restored — an undo of a delete, an undo of Delete All, a redo — and never
   * a new spawn. Without this, pressing Ctrl+Z after deleting something would
   * re-seat the very objects the undo just put back where they belonged.
   */
  const everSeenObjectIdsRef = useRef<Set<number>>(new Set());
  /**
   * Set while the shell itself is placing objects — an undo restore, a project
   * open, a new project. Those already carry exact positions, so the
   * free-space seating must keep its hands off them.
   */
  const suppressSeatingRef = useRef(false);
  /** Pending idle release of the engine's slice worker (constrained devices). */
  const workerReleaseTimerRef = useRef<number | null>(null);
  /**
   * True once this session has entered a paint mode, or opened a project that
   * carried painting. It is a one-way latch, and it vetoes two things.
   *
   * WHY IT EXISTS. Support and material painting live in the SELECTOR inside
   * the kernel's WASM heap, and nowhere else. Two consequences the shell has
   * to respect:
   *
   * 1. Releasing the worker destroys that state — and the viewer does not
   *    know. It caches the prepared mesh's identity outside the worker
   *    (`l.current = { identity, topology }` in viewer/dist/Viewport.js) and
   *    only re-sends `cmd:"prepare"` when that identity CHANGES, which
   *    terminating a worker does not. So after a release the brush paints into
   *    a kernel with no registered mesh, and `exportPaint` — which the 3MF
   *    save calls — hits the worker's `if (d.cmd === 'exportPaint' && !modPromise)`
   *    branch and answers `{supported:false, facets:[], hex:''}`. The project
   *    then saves, and uploads, with every painted facet stripped, reporting
   *    success. That is silent, permanent loss of the user's work.
   *
   * 2. The autosave skip cannot see paint either: brush strokes change the
   *    saved 3MF but change nothing in the scene fingerprint, the settings, or
   *    anything else projectContentSignature covers.
   *
   * So a painted session releases no worker and skips no save. Both
   * optimisations stay for everyone who never picks up the brush, which is the
   * overwhelming majority of sessions, and neither can cost anyone a stroke.
   */
  const sessionHasPaintRef = useRef(false);
  const suppressSeatingTimerRef = useRef<number | null>(null);
  /**
   * A restore is in flight and the objects it produces must not be seated.
   *
   * This is a LATCH, not a timer, and the difference matters. The timed window
   * below is right for `restoreScene` — that is synchronous, so anything it
   * emits arrives immediately. It is wrong for a project restore, and an
   * earlier version of this file got that wrong on a stated but false premise:
   * "the engine emits its objects events as it parses". It does not. The
   * viewer's `loadFiles` calls its refresh ONCE, after the whole file loop
   * (`addObject` only pushes into objectsRef and never refreshes), so a
   * restored .3mf produces exactly ONE objects event, for the entire scene.
   *
   * That makes any time-based window a bet on parse speed. The parse runs in a
   * worker, so the main thread stays idle and the timer fires exactly on time;
   * a small fixture beats it and a real 20-40 MB project does not — and losing
   * that bet re-seats every object and destroys the author's layout, on
   * precisely the projects big enough to care about. So the restore paths latch
   * instead: the next objects event is absorbed, whenever it arrives.
   */
  const restoreInFlightRef = useRef(false);

  /**
   * Holds the free-space seating off while the shell itself is placing
   * objects. A restore (undo, opening a project, a 3MF import) supplies exact
   * positions that must be honoured; objects appearing during it are recorded
   * as known but never moved. The window is generous because the engine emits
   * its objects events asynchronously as it parses.
   */
  const suppressSeating = useCallback((ms = 3_000) => {
    suppressSeatingRef.current = true;
    if (suppressSeatingTimerRef.current !== null) window.clearTimeout(suppressSeatingTimerRef.current);
    suppressSeatingTimerRef.current = window.setTimeout(() => {
      suppressSeatingTimerRef.current = null;
      suppressSeatingRef.current = false;
    }, ms);
  }, []);


  // The S4 typed engine adapter carries the LEVONIS theme into every engine
  // shadow root (event-driven — no polling); one instance for the shell's life.
  // Read once per mount: the answer cannot change without a reload, and it
  // decides the engine `features` prop, the autosave cadence and whether the
  // idle slice worker is released.
  const [device] = useState(currentDeviceProfile);
  const [adapter] = useState(() => createEngineAdapter({ themeCss: EDITOR_SHADOW_CSS }));
  const orchestrator = useMemo(() => createImportOrchestrator(adapter), [adapter]);
  const slicing = useSlicingState(adapter);

  const profile = PROFILES[profileId];
  const t = DICTIONARIES[locale];
  const requestedPresetKey = `${profileId}:${quality}:${strength}:${support}`;
  const profileLoading = loadedPresetKey !== requestedPresetKey;
  /**
   * The dictionary, for the preset effect's async continuation.
   *
   * It cannot take `t` as a dependency: that would make switching language
   * reload the printer profile and throw away every slice result. A ref kept
   * current by its own effect is the same trick `plateCountRef` uses below.
   */
  const textRef = useRef(t);

  // -- account persistence (S5: namespaced drafts + upload pipeline) ---------
  // Engine-driven full snapshot capture: click save-project through the
  // adapter and resolve with the exported 3MF when handleViewportExport fires
  // (or null after a timeout / when the engine is unavailable) — the sync
  // layer then falls back to an honestly-labeled source-only save.
  const captureEngineSnapshot = useCallback((): Promise<SnapshotCapture | null> => {
    if (exportIntentRef.current) return Promise.resolve(null);
    const safeName = (projectName.trim() || "LEVO Project").replace(/[^\p{L}\p{N}._-]+/gu, "-");
    // The engine's 3MF export walks every object's geometry and deflates it on
    // the main thread. Frames drawn during it are identical pictures that only
    // delay it — the engine exposes suspendRendering for exactly this case and
    // says so in its own doc comment. Resumed in settle(), on every path.
    const rendering = adapter.suspendRendering(true);
    return new Promise<SnapshotCapture | null>((resolve) => {
      let settled = false;
      const settle = (file: File | null) => {
        if (settled) return;
        settled = true;
        if (rendering) adapter.suspendRendering(false);
        if (snapshotResolverRef.current === settle) snapshotResolverRef.current = null;
        if (exportIntentRef.current === "persist") exportIntentRef.current = null;
        resolve(file ? { file, name: `${safeName}.3mf` } : null);
      };
      snapshotResolverRef.current = settle;
      exportIntentRef.current = "persist";
      if (!adapter.clickControl("save-project")) {
        settle(null);
        return;
      }
      window.setTimeout(() => settle(null), 30_000);
    });
  }, [adapter, projectName]);

  /**
   * Everything that would change the saved 3MF, as one cheap string.
   *
   * The autosave effect marks the session dirty whenever the objects array or
   * the settings object changes identity, which is far more often than the
   * project actually changes. Without this, every one of those fires paid for
   * a full engine export, a thumbnail read-back and a SHA-256 over a
   * multi-megabyte file before discovering the bytes were identical — the
   * upload hash can only skip the network, never the work.
   *
   * It must cover everything the snapshot depends on and nothing else. Scene
   * transforms, extruders and visibility come from the adapter's own
   * fingerprint; names, plates, the preset choice, the settings map and the
   * project name are added here.
   */
  const projectContentSignature = useCallback((): string | null => {
    if (!adapter.api()) return null;
    // Brush strokes change the saved 3MF and change nothing this signature can
    // see — they live in the kernel's selector, not in the scene, the settings
    // or the plate count. Returning null is the honest answer: it says "I
    // cannot tell whether this changed", and the controller then saves
    // unconditionally, exactly as it did before the skip existed.
    if (sessionHasPaintRef.current) return null;
    try {
      if (adapter.api()?.hasPaintImport?.()) return null;
    } catch {
      return null;
    }
    const settingsRecord = settings as unknown as Record<string, unknown>;
    const settingsPart = Object.keys(settingsRecord)
      .sort()
      .map((key) => `${key}=${JSON.stringify(settingsRecord[key])}`)
      .join("&");
    const namesPart = objects.map((object) => `${object.id}:${object.name}`).sort().join(",");
    return [
      projectName.trim(),
      `${profileId}:${quality}:${strength}:${support}`,
      `plates=${plateCount}`,
      namesPart,
      adapter.sceneFingerprint(),
      settingsPart,
    ].join("|");
  }, [adapter, objects, plateCount, profileId, projectName, quality, settings, strength, support]);

  const persistence = useProjectPersistence({
    user: user?.id ? { id: user.id } : null,
    captureSnapshot: captureEngineSnapshot,
    getSourceFiles: () => projectFilesRef.current,
    captureThumbnail: () => captureEngineThumbnail(adapter),
    // Plan decision 4 manifest: only what the shell actually knows — nothing
    // is invented (surface-paint data stays absent until the engine exposes it).
    buildManifest: (kind): ProjectManifest => ({
      version: 1,
      generator: "levo-studio",
      project: { name: projectName.trim() || "LEVO Project" },
      engine: { name: "three-slicer", version: "0.2.2" },
      printer: { profileId, model: profile.model, nozzle: profile.nozzle },
      settings: { quality, strength, support, global: settings as unknown as Record<string, unknown> },
      objects: objects.map((object) => ({ id: object.id, name: object.name, extruder: object.extruder })),
      plates: { count: plateCount },
      painting: { extruderAssignments: objects.some((object) => object.extruder > 1) },
      snapshot_kind: kind,
    }),
    buildDraft: ({ files, kind, contentHash, thumbnail }) => ({
      id: projectId,
      name: projectName.trim() || "LEVO Project",
      updatedAt: Date.now(),
      files,
      profileId,
      quality,
      strength,
      support,
      settings,
      objectCount: objects.length,
      plateCount,
      snapshotVersion: kind === "full" ? (2 as const) : undefined,
      snapshotKind: kind,
      contentHash,
      thumbnail,
    }),
    getMeta: () => ({ schemaVersion: 2, engineVersion: "three-slicer@0.2.2" }),
    contentSignature: () => projectContentSignature(),
    /**
     * NOT WHILE A SLICE IS RUNNING.
     *
     * The effect below already refuses to call `markDirty()` during a slice,
     * and that was not enough: on a constrained device the debounce is nine
     * seconds, so a timer armed by the edit that PRECEDED the slice fires
     * squarely inside it — and what runs then is a full engine 3MF export, a
     * canvas read-back and a SHA-256 over the whole file, on the main thread,
     * while the kernel has the CPU and the phone's memory is already spent on
     * the WASM heap. The save is deferred, never dropped.
     */
    busy: () => status === "slicing",
    // A save costs a full 3MF export, a canvas read-back and a SHA-256 over
    // the result. On a phone that is worth doing less often; see
    // app/device-profile.ts.
    debounceMs: device.autosaveDebounceMs,
  });

  // Surface the hook's local-save bookkeeping in the existing status labels:
  // derived at render time (newest of the hook's record and the restore-time
  // value) — no state mirroring.
  const hookSavedAt = persistence.state.lastLocalSaveAt;
  const hookIsNewer = hookSavedAt !== null && (lastAutosavedAt === null || hookSavedAt >= lastAutosavedAt);
  const displaySavedAt = hookIsNewer ? hookSavedAt : lastAutosavedAt;
  const displaySavedKind = hookIsNewer ? (persistence.state.lastLocalKind ?? lastSavedKind) : lastSavedKind;

  // -- engine module load ----------------------------------------------------
  useEffect(() => {
    let active = true;
    registerExtendedModelLoaders()
      .then(() => Promise.all([import("three-slicer/viewer"), import("three-slicer/components")]))
      .then(([viewerModule, componentsModule]) => {
        if (!active) return;
        setViewport(() => viewerModule.default);
        setSettingsPanel(() => componentsModule.default);
        setStatus("editing");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "The editor engine could not be loaded.");
        setStatus("error");
      });
    return () => { active = false; };
  }, []);

  // -- adapter lifecycle -----------------------------------------------------
  useEffect(() => {
    const container = viewportMountRef.current;
    if (!container) return;
    adapter.attach(container);
    return () => adapter.detach();
  }, [adapter]);

  useEffect(() => () => orchestrator.dispose(), [orchestrator]);

  useEffect(() => {
    adapter.setHostAttribute("data-levo-sidebar", sidebarOpen ? "open" : "closed");
  }, [adapter, sidebarOpen]);

  // -- locale ----------------------------------------------------------------
  useEffect(() => { setLocale(readStoredLocale()); }, []);
  useEffect(() => { applyLocaleToDocument(locale); }, [locale]);
  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    storeLocale(next);
  }, []);

  // -- native environment (capability-gated; everything false on the web) ----
  useEffect(() => {
    let active = true;
    detectNativePrinterEnvironment().then((environment) => {
      if (!active) return;
      setNativeEnvironment(environment);
      if (!environment.native || !environment.capabilities.lanConnection) setPrinterStatus({ connected: false });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!printerStatus.connected || !nativeEnvironment.capabilities.telemetry) return;
    const refresh = () => {
      getNativePrinterStatus().then((next) => {
        setPrinterStatus(next);
        if (next.error) setLanMessage(next.error);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [nativeEnvironment.capabilities.telemetry, printerStatus.connected]);

  useEffect(() => { plateCountRef.current = plateCount; }, [plateCount]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { textRef.current = t; }, [t]);

  useEffect(() => () => {
    if (exportIntentTimerRef.current !== null) window.clearTimeout(exportIntentTimerRef.current);
  }, []);

  // -- profile / preset loading (honest missing-preset reporting) ------------
  useEffect(() => {
    const requestId = profileRequestRef.current + 1;
    profileRequestRef.current = requestId;
    const nextSelection: PresetSelection = { printerId: profileId, quality, strength, support };
    setProfileLoadState(null);
    loadPrinterProfile(profile, quality, strength, support)
      .then((loaded) => {
        if (profileRequestRef.current !== requestId) return;
        machineRef.current = loaded.machine;
        const restored = restoredSettingsRef.current?.key === requestedPresetKey ? restoredSettingsRef.current.settings : null;
        if (restored) restoredSettingsRef.current = null;
        /**
         * THE SELECTOR TAKES BACK ITS OWN KEYS, AND NOTHING ELSE.
         *
         * This used to be `setSettings(restored ?? loaded.settings)` — the map
         * rebuilt from scratch — followed by `setNotice("")`. So flipping the
         * Support switch, which has nothing to do with infill, discarded a
         * hand-tuned infill density, every changed filament temperature and
         * anything else the owner had set, and then cleared the message line
         * so nothing said so. See app/settings-carryover.ts for the rule.
         *
         * A restored project is exempt: its saved map already IS the user's
         * settings, and there is nothing to carry onto it.
         */
        if (restored) {
          setSettings(restored);
          userEditedKeysRef.current = new Set();
          setNotice("");
        } else {
          const carried = carryUserEdits({
            loaded: loaded.settings,
            previous: settingsRef.current,
            editedKeys: userEditedKeysRef.current,
            previousSelection: loadedSelectionRef.current,
            nextSelection,
            processKeys: loaded.processKeys,
          });
          setSettings(carried.settings);
          userEditedKeysRef.current = new Set(carried.kept);
          const text = textRef.current;
          setNotice(
            carried.overwritten.length
              ? templateText(text.presetTookEdits, {
                count: carried.overwritten.length,
                names: carried.overwritten.slice(0, 4).join("، "),
              })
              : carried.kept.length
                ? templateText(text.presetKeptEdits, { count: carried.kept.length })
                : ""
          );
        }
        loadedSelectionRef.current = nextSelection;
        setProfileLoadState({ verified: loaded.verified, missingPresets: loaded.missingPresets });
        slicing.clearResults();
        setHandyProjectReady(false);
        setLoadedPresetKey(requestedPresetKey);
      })
      .catch((reason: unknown) => {
        if (profileRequestRef.current !== requestId) return;
        setLoadedPresetKey(requestedPresetKey);
        setProfileLoadState({ verified: false, missingPresets: [] });
        setError(reason instanceof Error ? reason.message : "The printer profile could not be loaded.");
      });
    // slicing.clearResults is identity-stable per hook instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, quality, requestedPresetKey, strength, support]);

  // -- settings (engine SettingsPanel binding stays; machine keys locked) ----
  const setEditorSettings: Dispatch<SetStateAction<SlicerSettings>> = useCallback((next) => {
    setSettings((current) => {
      const proposed = typeof next === "function" ? next(current) : next;
      /**
       * Only the MACHINE's own keys are pinned — see app/machine-lock.ts.
       *
       * This used to re-apply every key in three-slicer's `printerKeys`, a
       * list documented as "every option key a printer profile CAN set" and
       * meant for clearing on a printer switch. It contains `layer_height`,
       * `z_hop` and all sixteen `machine_max_*`, so changing the layer height
       * snapped back to the profile's value and the whole Motion panel was
       * inert. That is «الإعدادات لا تطبق».
       */
      const locked = applyMachineLock(proposed, machineRef.current);
      /**
       * Remember WHICH keys the user changed, so a later preset change can
       * carry them instead of discarding them — app/settings-carryover.ts.
       * Machine keys can never land here: `applyMachineLock` has just pinned
       * them back to the preset, so they compare equal.
       */
      for (const key of changedKeys(current, locked)) userEditedKeysRef.current.add(key);
      return locked;
    });
    // Any settings change makes stored slice results stale — never silently
    // exportable as if produced by the new settings.
    slicing.notifySettingsChanged();
    setHandyProjectReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slicing.notifySettingsChanged]);

  // -- adapter-backed controls ----------------------------------------------
  const clickControl = useCallback((testId: EngineTestId, silent = false) => {
    const clicked = adapter.clickControl(testId);
    if (!clicked && !silent) setNotice(t.actionUnavailable);
    if (clicked) setNotice("");
    return clicked;
  }, [adapter, t.actionUnavailable]);

  const runTool = useCallback((testId: EngineTestId) => {
    setToolTrayOpen(false);
    void adapter.runPrepareAction(testId).then((clicked) => {
      if (!clicked) setNotice(t.actionUnavailable);
    });
  }, [adapter, t.actionUnavailable]);

  const shortcut = useCallback((key: string) => {
    if (!adapter.sendShortcut(key)) setNotice(t.actionUnavailable);
    else setNotice("");
  }, [adapter, t.actionUnavailable]);

  // -- import (S4 orchestrator: ZIP budgets + deferred archive arrangement) --
  const localizeImportNotice = useCallback((entry: ImportNotice): string => {
    if (entry.kind === "imported") return t.imported;
    if (entry.kind === "archive-arranged") return templateText(t.zipArranged, { models: entry.models, plates: entry.plates });
    if (entry.kind === "archive-oversized") return templateText(t.zipOversized, { count: entry.count });
    return templateText(t.zipOverflow, { count: entry.count });
  }, [t.imported, t.zipArranged, t.zipOverflow, t.zipOversized]);

  const localizeImportError = useCallback((reason: unknown): string => {
    if (reason instanceof ImportError) {
      if (reason.code === "empty-file") return `${t.emptyFile} ${reason.fileName ?? ""}`.trim();
      if (reason.code === "engine-unavailable") return t.engineUnavailable;
      if (reason.code === "entry-count") return t.zipEntryLimit;
      if (reason.code === "expansion-budget") return t.zipBudgetExceeded;
      if (reason.code === "expansion-ratio") return t.zipRatioLimit;
      return t.importFailed;
    }
    return reason instanceof Error ? reason.message : t.importFailed;
  }, [t.emptyFile, t.engineUnavailable, t.importFailed, t.zipBudgetExceeded, t.zipEntryLimit, t.zipRatioLimit]);

  const importSelectedFiles = useCallback(async (rawFiles: File[]) => {
    if (!rawFiles.length || orchestrator.busy) return;
    setError("");
    setNotice("");
    setToolTrayOpen(false);
    // A 3MF is a PROJECT: it carries the author's own plate layout, and the
    // engine restores those positions itself as it parses. Re-seating them
    // would throw that layout away. The orchestrator is already finished by
    // the time the engine emits the objects (only a ZIP leaves a pending
    // arrangement behind), so `orchestrator.busy` cannot be the guard here.
    if (rawFiles.some((file) => /\.3mf$/i.test(file.name))) restoreInFlightRef.current = true;
    const importNotices: string[] = [];
    try {
      const result = await orchestrator.importFiles(rawFiles, {
        existingObjectIds: new Set(objects.map((object) => object.id)),
        plateCount: plateCountRef.current,
        selectedPlate,
        bedWidth: profile.bedWidth,
        bedDepth: profile.bedDepth,
      }, {
        onProgress: (progress: ImportProgressUpdate | null) => {
          if (!progress) { setImportProgress(null); return; }
          setImportProgress({
            label: progress.stage === "analyzing" ? t.importing : t.zipAnalyzing,
            ratio: progress.ratio,
            extracted: progress.extractedFiles,
          });
        },
        onNotice: (entry) => {
          importNotices.push(localizeImportNotice(entry));
          setNotice(importNotices.join(" "));
          if (entry.kind !== "imported") setStatus((current) => current === "slicing" ? current : "editing");
        },
        onBudgetExceeded: (info) => window.confirm(templateText(t.zipBudgetConfirm, {
          size: Math.ceil(info.expandedBytes / MB),
          budget: Math.ceil(info.budgetBytes / MB),
          hard: Math.ceil(info.hardLimitBytes / MB),
        })),
      });
      projectFilesRef.current = [...projectFilesRef.current, ...result.importedFiles];
    } catch (reason: unknown) {
      // Nothing was restored, so nothing is coming to absorb the latch.
      restoreInFlightRef.current = false;
      setImportProgress(null);
      setError(localizeImportError(reason));
      setStatus("error");
    }
  }, [localizeImportError, localizeImportNotice, objects, orchestrator, profile.bedDepth, profile.bedWidth, selectedPlate, t.importing, t.zipAnalyzing, t.zipBudgetConfirm]);

  const handlePickedFiles = useCallback((files: File[]) => {
    setNotice("");
    setToolTrayOpen(false);
    void importSelectedFiles(files);
  }, [importSelectedFiles]);

  const handleDropFiles = useCallback((event: React.DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void importSelectedFiles(files);
  }, [importSelectedFiles]);

  // -- general arrange (all current objects, undoable — S4) ------------------
  /**
   * ONE UNDO IN THE BAR, FOR THE THING THAT WAS JUST DONE.
   *
   * Arrange, orient and cut each raised their own undo flag and cleared none
   * of the others — only the undo HANDLERS cleared siblings. So arrange, then
   * orient, then cut left three pills in the notice bar, beside the message
   * text and the close button, inside 306px of width on a phone. Nothing in
   * that row could be read, and two of the three pills would have undone a
   * step that was no longer the last one anyway.
   *
   * These three operations are alternatives, not a stack: each one re-arranges
   * the same plate, and the engine keeps no history across them. So raising
   * one lowers the rest, here, at the single point that sets any of them.
   */
  const raiseUndo = useCallback((which: "arrange" | "orient" | "cut", available: boolean) => {
    setArrangeUndoAvailable(which === "arrange" && available);
    setOrientUndoAvailable(which === "orient" && available);
    setCutUndoAvailable(which === "cut" && available);
  }, []);

  const arrangeAll = useCallback(async () => {
    setToolTrayOpen(false);
    if (!objects.length) { setNotice(t.arrangeUnavailable); return; }
    const result = await arrangeCurrentObjects(adapter, {
      bedWidth: profile.bedWidth,
      bedDepth: profile.bedDepth,
      selectedPlate,
    });
    if (!result.ok) { setNotice(t.arrangeUnavailable); return; }
    arrangeUndoRef.current = result.undo;
    raiseUndo("arrange", Boolean(result.undo));
    const messages = [templateText(t.arrangeDone, { models: result.arrangedCount, plates: Math.max(1, result.platesUsed) })];
    if (result.oversizedCount) messages.push(templateText(t.zipOversized, { count: result.oversizedCount }));
    if (result.overflowCount) messages.push(templateText(t.zipOverflow, { count: result.overflowCount }));
    setNotice(messages.join(" "));
  }, [adapter, objects.length, profile.bedDepth, profile.bedWidth, raiseUndo, selectedPlate, t.arrangeDone, t.arrangeUnavailable, t.zipOverflow, t.zipOversized]);

  // -- auto-orient (BambuStudio's scoring, undoable) -------------------------
  /**
   * Orients every object for printing. The search is a synchronous pass over
   * the raw triangles, so rendering is suspended around it: on a dense mesh the
   * engine's own render loop would otherwise fight the main thread for the very
   * milliseconds the measurement needs.
   *
   * The busy flag is set BEFORE the yield, so the button reports itself as
   * working rather than looking dead on a big part.
   */
  const orientAll = useCallback(async () => {
    setToolTrayOpen(false);
    if (!objects.length) { setNotice(t.orientUnavailable); return; }
    setOrienting(true);
    setNotice(t.orientBusy);
    const api = adapter.api();
    api?.suspendRendering(true);
    // One frame, so the busy notice actually paints before the blocking pass.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let result;
    try {
      result = autoOrientObjects(adapter, { selectedPlate });
    } finally {
      api?.suspendRendering(false);
      setOrienting(false);
    }
    if (!result.ok) { setNotice(t.orientUnavailable); return; }
    orientUndoRef.current = result.undo;
    raiseUndo("orient", Boolean(result.undo));
    const total = result.orientedCount + result.alreadyBestCount + result.skippedCount;
    const messages = result.orientedCount
      ? [templateText(t.orientDone, { oriented: result.orientedCount, total })]
      : [t.orientNoChange];
    if (result.skippedCount) messages.push(templateText(t.orientSkipped, { skipped: result.skippedCount }));
    if (result.lockedCount) messages.push(templateText(t.orientLocked, { locked: result.lockedCount }));
    setNotice(messages.join(" "));
  }, [adapter, objects.length, raiseUndo, selectedPlate, t.orientBusy, t.orientDone, t.orientLocked,
      t.orientNoChange, t.orientSkipped, t.orientUnavailable]);

  /**
   * BOTH UNDOS ARE WHOLE-SCENE RESTORES, so using either makes the other stale:
   * restoring the pre-orient scene also throws away an arrangement made after
   * it, and vice versa. Offering the second button afterwards would promise an
   * undo of something that is already gone — so each one clears the other.
   */
  const undoOrient = useCallback(() => {
    const undo = orientUndoRef.current;
    orientUndoRef.current = null;
    setOrientUndoAvailable(false);
    arrangeUndoRef.current = null;
    setArrangeUndoAvailable(false);
    cutUndoRef.current = null;
    setCutUndoAvailable(false);
    suppressSeating();
    if (undo?.()) setNotice(t.orientUndone);
    else setNotice(t.actionUnavailable);
  }, [suppressSeating, t.actionUnavailable, t.orientUndone]);

  // -- plane cut (one object into two, undoable) -----------------------------
  /**
   * Opens the cut sheet, seeded with the SELECTED object's own extent. Reading
   * the range first is what makes the slider mean something: a control bounded
   * by the model rather than by a guess cannot ask for a cut that misses.
   */
  const openCut = useCallback(() => {
    setToolTrayOpen(false);
    const range = cutRange(adapter);
    if (!range || range.max - range.min <= 0.001) { setNotice(t.cutUnavailable); return; }
    setCutBounds({ min: range.min, max: range.max });
    setCutOffset((range.min + range.max) / 2);
    setSheet("cut");
  }, [adapter, t.cutUnavailable]);

  const applyCut = useCallback(() => {
    setCutting(true);
    const api = adapter.api();
    api?.suspendRendering(true);
    let result;
    try {
      result = cutObject(adapter, { offset: cutOffset, keep: cutKeep, cap: cutCap, selectedPlate });
    } finally {
      api?.suspendRendering(false);
      setCutting(false);
    }
    if (!result.ok) {
      setNotice(result.reason === "plane-missed" ? t.cutMissed : t.cutUnavailable);
      return;
    }
    setSheet(null);
    cutUndoRef.current = result.undo;
    raiseUndo("cut", Boolean(result.undo));
    const messages = [templateText(t.cutDone, { pieces: result.pieceIds.length })];
    // A cut face that could not be closed leaves a hole in a piece that will
    // then slice badly. Saying so is the difference between a tool and a toy.
    if (result.openChains) messages.push(templateText(t.cutOpen, { open: result.openChains }));
    if (result.skippedLoops) messages.push(templateText(t.cutSkipped, { skipped: result.skippedLoops }));
    setNotice(messages.join(" "));
  }, [adapter, cutCap, cutKeep, cutOffset, raiseUndo, selectedPlate, t.cutDone, t.cutMissed, t.cutOpen,
      t.cutSkipped, t.cutUnavailable]);

  const undoCut = useCallback(() => {
    const undo = cutUndoRef.current;
    cutUndoRef.current = null;
    setCutUndoAvailable(false);
    arrangeUndoRef.current = null;
    setArrangeUndoAvailable(false);
    orientUndoRef.current = null;
    setOrientUndoAvailable(false);
    suppressSeating();
    if (undo?.()) setNotice(t.cutUndone);
    else setNotice(t.actionUnavailable);
  }, [suppressSeating, t.actionUnavailable, t.cutUndone]);

  const undoArrange = useCallback(() => {
    const undo = arrangeUndoRef.current;
    arrangeUndoRef.current = null;
    orientUndoRef.current = null;
    setOrientUndoAvailable(false);
    cutUndoRef.current = null;
    setCutUndoAvailable(false);
    setArrangeUndoAvailable(false);
    // A restore re-creates objects at their captured positions; seating them
    // again would undo the undo.
    suppressSeating();
    if (undo?.()) setNotice(t.arrangeUndone);
    else setNotice(t.actionUnavailable);
  }, [suppressSeating, t.actionUnavailable, t.arrangeUndone]);

  // -- autosave: the S5 sync layer owns debounce, capture, draft + upload ----
  // Any edit signal marks the session dirty; the controller then captures a
  // full engine snapshot (falling back to an honestly-labeled source-only
  // save), writes the namespaced local draft, and uploads when the session
  // is signed in and linked to an account project.
  const { markDirty } = persistence;
  useEffect(() => {
    if (!objects.length || !projectFilesRef.current.length || orchestrator.busy || status === "slicing") return;
    markDirty();
  }, [markDirty, objects, orchestrator, profileId, projectName, quality, settings, status, strength, support]);

  const openProjects = useCallback(async () => {
    setSheet("projects");
  }, []);

  const restoreProjectRecord = useCallback(async (saved: StoredLevoProject, options?: { relink?: boolean }) => {
    const restoredProfile = isProfileId(saved.profileId) ? saved.profileId : DEFAULT_PROFILE_ID;
    const restoredQuality = saved.quality in QUALITY ? saved.quality as QualityId : "standard";
    const restoredStrength = saved.strength in STRENGTH ? saved.strength as StrengthId : "standard";
    const restoredSupport = Boolean(saved.support);
    const restoredKey = `${restoredProfile}:${restoredQuality}:${restoredStrength}:${restoredSupport}`;
    profileRequestRef.current += 1;
    restoredSettingsRef.current = saved.settings && restoredKey !== requestedPresetKey
      ? { key: restoredKey, settings: saved.settings }
      : null;
    slicing.clearResults();
    orchestrator.clearPendingArrangement();
    // A saved project carries its own layout — restore it, do not re-seat it.
    // The latch waits for the objects event however long the parse takes.
    restoreInFlightRef.current = true;
    projectFilesRef.current = saved.files;
    setProjectId(saved.id);
    setProjectName(saved.name);
    setProfileId(restoredProfile);
    setQuality(restoredQuality);
    setStrength(restoredStrength);
    setSupport(restoredSupport);
    if (saved.settings) setSettings(saved.settings);
    setObjects([]);
    setWorkspaceKey((value) => value + 1);
    setSheet(null);
    for (let frame = 0; frame < 5; frame += 1) await nextFrame();
    try {
      await adapter.dispatchFiles(saved.files);
    } catch {
      setError(t.engineUnavailable);
      setStatus("error");
      return;
    }
    setLastAutosavedAt(saved.updatedAt);
    const kind = resolveSnapshotKind(saved);
    setLastSavedKind(kind);
    setNotice(kind === "full" ? t.savedLocalFull : t.savedLocalSourceOnly);
    // Re-link the sync layer to the draft's account project (bookkeeping only
    // — sync state itself is owned by the controller), or unlink for a
    // local-only draft so edits never upload to the wrong project. Skipped
    // when the caller (openAccountProjectInEditor) already linked with the
    // full synced-baseline marker.
    if (options?.relink !== false) {
      if (saved.remote?.projectId) {
        persistence.linkRemoteProject(saved.remote.projectId, saved.remote.revision ?? null);
      } else {
        persistence.unlinkRemoteProject();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, orchestrator, requestedPresetKey, t.engineUnavailable, t.savedLocalFull, t.savedLocalSourceOnly]);

  // Open an account project: download the head revision (ownership enforced
  // server-side), restore files + manifest settings, and surface a degraded
  // (source-only) restore honestly (mandate §4).
  const openAccountProjectInEditor = useCallback(async (summary: RemoteProjectSummary) => {
    let opened: OpenedRemoteProject;
    try {
      opened = await persistence.openAccountProject(summary.id);
    } catch {
      setNotice(t.actionUnavailable);
      return;
    }
    const manifest = opened.manifest;
    const manifestProfile = manifest?.printer?.profileId;
    const record: StoredLevoProject = {
      id: opened.project.id,
      name: opened.project.name,
      updatedAt: Date.now(),
      files: opened.files,
      profileId: typeof manifestProfile === "string" ? manifestProfile : DEFAULT_PROFILE_ID,
      quality: typeof manifest?.settings?.quality === "string" ? manifest.settings.quality : "standard",
      strength: typeof manifest?.settings?.strength === "string" ? manifest.settings.strength : "standard",
      support: Boolean(manifest?.settings?.support),
      settings: manifest?.settings?.global as SlicerSettings | undefined,
      objectCount: manifest?.objects?.length,
      plateCount: manifest?.plates?.count,
      snapshotVersion: opened.snapshotKind === "full" ? 2 : undefined,
      snapshotKind: opened.snapshotKind ?? "source-only",
    };
    await restoreProjectRecord(record, { relink: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence.openAccountProject, restoreProjectRecord, t.actionUnavailable]);

  // Create an account project, link the session, and push the current editor
  // content as its first revision.
  const createAccountProject = useCallback(async (name: string) => {
    const project = await persistence.createRemoteProjectAndLink(name);
    if (projectFilesRef.current.length) void persistence.saveNow();
    return project;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence.createRemoteProjectAndLink, persistence.saveNow]);

  // -- LAN (native bridge only; unreachable on the web by capability gating) -
  const discoverLan = useCallback(async () => {
    if (!nativeEnvironment.capabilities.discovery || lanAction !== "idle") return;
    setLanAction("discovering");
    setLanMessage("");
    try {
      const printers = await discoverNativePrinters();
      setDiscoveredPrinters(printers);
      if (!printers.length) setLanMessage(t.noPrintersFound);
    } catch (reason: unknown) {
      setLanMessage(reason instanceof Error ? reason.message : t.actionUnavailable);
    } finally {
      setLanAction("idle");
    }
  }, [lanAction, nativeEnvironment.capabilities.discovery, t.actionUnavailable, t.noPrintersFound]);

  const connectLan = useCallback(async () => {
    if (!nativeEnvironment.capabilities.lanConnection || lanAction !== "idle") return;
    setLanAction("connecting");
    setLanMessage("");
    try {
      const connected = await connectNativePrinter({
        ip: lanIp,
        accessCode: lanAccessCode,
        serial: lanSerial.trim() || undefined,
        remember: false,
      });
      setPrinterStatus(connected);
      if (connected.connected) {
        setLanAccessCode("");
        setLanMessage(connected.error ?? `${t.connectedPrinter}: ${connected.printer?.name ?? connected.printer?.ip ?? lanIp}`);
      }
    } catch (reason: unknown) {
      setPrinterStatus({ connected: false });
      setLanMessage(reason instanceof Error ? reason.message : t.actionUnavailable);
    } finally {
      setLanAction("idle");
    }
  }, [lanAccessCode, lanAction, lanIp, lanSerial, nativeEnvironment.capabilities.lanConnection, t.actionUnavailable, t.connectedPrinter]);

  const disconnectLan = useCallback(async () => {
    if (lanAction !== "idle") return;
    setLanAction("connecting");
    try {
      setPrinterStatus(await disconnectNativePrinter());
      setLanMessage("");
    } catch (reason: unknown) {
      setLanMessage(reason instanceof Error ? reason.message : t.actionUnavailable);
    } finally {
      setLanAction("idle");
    }
  }, [lanAction, t.actionUnavailable]);

  const transmitNativePrint = useCallback(async () => {
    const baseName = `LEVO-${profile.shortName}-plate-${selectedPlate + 1}`;
    const gcodeFile = slicing.freshGcodeFile(selectedPlate, `${baseName}.gcode`);
    if (!gcodeFile) {
      setLanMessage(slicing.resultState(selectedPlate) === "stale" ? t.printStale : t.printNotReady);
      return;
    }
    const required = nativeEnvironment.capabilities;
    if (!printerStatus.connected || (!required.packagePrintJob && !required.rawGcodePrintJob) || !required.fileTransfer || !required.startPrint) {
      setLanMessage(t.lanBridgeIncomplete);
      return;
    }
    let checksum: string;
    try { checksum = await sha256Hex(gcodeFile); }
    catch { setLanMessage(t.actionUnavailable); return; }
    const confirmed = window.confirm(templateText(t.confirmLanPrint, {
      file: gcodeFile.name,
      printer: printerStatus.printer?.name ?? printerStatus.printer?.ip ?? "Bambu printer",
      profile: `${profile.model} · ${profile.nozzle} mm`,
      plate: selectedPlate + 1,
      checksum: checksum.slice(0, 16),
    }));
    if (!confirmed) return;
    setLanAction("transferring");
    setLanTransferProgress(0);
    setLanMessage("");
    try {
      await sendNativePrintJob({
        gcode: gcodeFile,
        metadata: {
          name: baseName,
          profileId: profile.id,
          printerModel: profile.model,
          plate: selectedPlate + 1,
          nozzleDiameter: profile.nozzle,
        },
        onProgress: setLanTransferProgress,
      });
      setLanMessage(t.lanPrintQueued);
    } catch (reason: unknown) {
      setLanMessage(reason instanceof Error ? reason.message : t.actionUnavailable);
    } finally {
      setLanAction("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeEnvironment.capabilities, printerStatus, profile, selectedPlate, slicing.freshGcodeFile, slicing.resultState, t.actionUnavailable, t.confirmLanPrint, t.lanBridgeIncomplete, t.lanPrintQueued, t.printNotReady, t.printStale]);

  // -- 3MF export intents (engine save-project via adapter) ------------------
  /**
   * Completes a Bambu-project export once the engine has produced its 3MF.
   *
   * Async because the preview is a real canvas read-back, and
   * `handleViewportExport` must answer the engine synchronously — it returns
   * `true` to say "I have taken this file, do not download it yourself" and
   * this finishes afterwards. If the conversion throws, the ENGINE'S OWN file
   * is downloaded instead: the user came here for a file, and a broken
   * envelope is not a reason to send them away with nothing.
   */
  const finishBambuProject = useCallback(async (
    file: File | Blob,
    overrideFilename?: string,
    onDone?: () => void
  ) => {
    const safeName = (projectName.trim() || "LEVO Project").replace(/[^\p{L}\p{N}._-]+/gu, "-");
    const filename = overrideFilename ?? `${safeName}.3mf`;
    try {
      const [{ toBambuProject }, big, small] = await Promise.all([
        import("./bambu-project-3mf"),
        captureEngineThumbnail(adapter, { width: 512, height: 512 }),
        captureEngineThumbnail(adapter, { width: 128, height: 128 }),
      ]);
      // Read the two captured thumbnails out BEFORE the canvas is stood down:
      // they are already Blobs by this point, but keeping the order explicit
      // means a future change cannot accidentally ask a suspended renderer for
      // a frame and get a blank one.
      const thumbnailPng = big ? new Uint8Array(await big.arrayBuffer()) : null;
      const thumbnailSmallPng = small ? new Uint8Array(await small.arrayBuffer()) : null;
      /**
       * THE CANVAS STOPS WHILE THE PROJECT IS REPACKAGED.
       *
       * `toBambuProject` inflates the engine's 3MF and deflates a new one, in
       * one synchronous pass, on the main thread, holding both in memory —
       * and on a constrained device the slice worker's WASM heap is still
       * resident beside it. Leaving the 3D view rendering through that means
       * the renderer competes for the same thread and the same budget for the
       * whole conversion, on the devices least able to afford either.
       *
       * `captureEngineSnapshot` already does exactly this for the autosave
       * export; this path is the one the owner reaches by hand, from "save
       * project" and "prepare for Bambu Handy", and it did not.
       *
       * The helper restores rendering on every path, including a throw, so a
       * failed conversion cannot leave a dead viewport behind.
       */
      const result = await adapter.withRenderingSuspended(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return toBambuProject(bytes, {
          projectName: projectName.trim() || "LEVO Project",
          application: LEVO_APPLICATION,
          version: LEVO_VERSION,
          createdAt: new Date().toISOString().slice(0, 10),
          thumbnailPng,
          thumbnailSmallPng,
          printerModelId: profile.shortName,
          nozzleDiameters: profile.nozzle ? String(profile.nozzle) : undefined,
        });
      });
      downloadBlob(new Blob([result.bytes as BlobPart], { type: "model/3mf" }), filename);
      if (onDone) onDone();
      // Honest notice: name the one thing that could not be included.
      else setNotice(result.warnings.length > 0 ? `${t.projectFileReady} — ${result.warnings[0]}` : t.projectFileReady);
    } catch {
      downloadBlob(file, filename);
      if (onDone) onDone();
      else setNotice(t.projectFileReady);
    }
  }, [adapter, profile.nozzle, profile.shortName, projectName, t.projectFileReady]);

  const handleViewportExport = useCallback<NonNullable<ViewportProps["onExport"]>>((file, filename) => {
    const intent = exportIntentRef.current;
    if (!intent || !filename.toLowerCase().endsWith(".3mf")) return;
    exportIntentRef.current = null;
    if (exportIntentTimerRef.current !== null) {
      window.clearTimeout(exportIntentTimerRef.current);
      exportIntentTimerRef.current = null;
    }
    if (intent === "bambu-project") {
      // The engine hands back a real 3MF; this adds the Bambu project envelope
      // (schema markers, the project_settings header BambuStudio identifies the
      // settings by, a preview and the package relationships) and downloads it
      // under the PROJECT's name rather than the first object's. See
      // app/bambu-project-3mf.ts for what is and is not written.
      void finishBambuProject(file);
      return true;
    }
    if (intent === "persist") {
      // Engine snapshot capture for the S5 sync layer (captureEngineSnapshot).
      const safeName = (projectName.trim() || "LEVO Project").replace(/[^\p{L}\p{N}._-]+/gu, "-");
      const snapshot = new File([file], `${safeName}.3mf`, { type: "model/3mf", lastModified: Date.now() });
      projectFilesRef.current = [snapshot];
      suppressNextExportNoticeRef.current = true;
      snapshotResolverRef.current?.(snapshot);
    } else {
      // The MakerWorld/Handy file is the SAME file as the project save — one
      // converter, one shape. Before this it was the engine's raw output, so
      // two buttons a few pixels apart produced two different 3MFs and only
      // one of them carried the user's settings in a form Bambu Studio reads.
      // Only the filename differs, because this one names the printer it was
      // prepared for.
      void finishBambuProject(file, `LEVO-${profile.shortName}-Bambu-Handy.3mf`, () => {
        setHandyProjectReady(true);
        setNotice(t.handyFileReady);
      });
    }
    return true;
  }, [finishBambuProject, profile.shortName, projectName, t.handyFileReady]);

  /** Save the open project as a Bambu-shaped .3mf — never gated on a slice. */
  const saveBambuProject = useCallback(() => {
    exportIntentRef.current = "bambu-project";
    if (!adapter.clickControl("save-project")) {
      exportIntentRef.current = null;
      setNotice(t.actionUnavailable);
      return;
    }
    if (exportIntentTimerRef.current !== null) window.clearTimeout(exportIntentTimerRef.current);
    exportIntentTimerRef.current = window.setTimeout(() => {
      if (exportIntentRef.current !== "bambu-project") return;
      exportIntentRef.current = null;
      exportIntentTimerRef.current = null;
      setNotice(t.actionUnavailable);
    }, 30_000);
  }, [adapter, t.actionUnavailable]);

  const prepareForBambuHandy = useCallback(() => {
    setHandyProjectReady(false);
    exportIntentRef.current = "bambu-handy";
    if (!adapter.clickControl("save-project")) {
      exportIntentRef.current = null;
      setNotice(t.actionUnavailable);
      return;
    }
    if (exportIntentTimerRef.current !== null) window.clearTimeout(exportIntentTimerRef.current);
    exportIntentTimerRef.current = window.setTimeout(() => {
      if (exportIntentRef.current !== "bambu-handy") return;
      exportIntentRef.current = null;
      exportIntentTimerRef.current = null;
      setNotice(t.actionUnavailable);
    }, 30_000);
  }, [adapter, t.actionUnavailable]);

  // -- slice worker lifecycle ------------------------------------------------
  //
  // The engine keeps its slice worker for the lifetime of the page: it is only
  // ever terminated on unmount. After a slice, that worker still holds the
  // grown WASM heap (WebAssembly memory never shrinks) and, on the threaded
  // kernel, the whole `navigator.hardwareConcurrency` pthread pool it spawned.
  // On a phone that is why the SECOND slice is the one that dies.
  //
  // `patches/three-slicer+0.2.2.patch` adds the entry point that lets the
  // engine hand it back; the shell decides when. Releasing is not free — the
  // next slice recompiles the kernel — so it is only done where the memory is
  // worth more than the warm start: on a memory-constrained device after an
  // idle period, and whenever the tab goes to the background.
  //
  // The release itself refuses while a slice is pending, so none of this can
  // interrupt work. It is not a cancel and is never used as one.
  const cancelIdleWorkerRelease = useCallback(() => {
    if (workerReleaseTimerRef.current !== null) {
      window.clearTimeout(workerReleaseTimerRef.current);
      workerReleaseTimerRef.current = null;
    }
  }, []);

  /**
   * THE HEAP THE SECOND SLICE LANDS ON.
   *
   * Releasing the idle worker above covers the case where the user walks away
   * between slices. It does nothing for the one the owner actually hits:
   * slice, look at the preview, change something, slice again — forty seconds
   * of work, no idle window, and the engine has been holding the first slice's
   * intermediate stages in the WASM heap the whole time because the viewer
   * forces `keep_stages: true` on every non-economy run. The kernel's own
   * default is `false` and its parameter table calls the override "a memory
   * trade-off"; on a phone that trade buys a faster re-slice that the tab does
   * not live long enough to perform.
   *
   * So a constrained device takes the kernel's default. Desktops keep the
   * cache — see engine-adapter.ts#setStageCacheAllowed for the whole reasoning
   * and for why `reuse_stages` has to go with it.
   */
  useEffect(() => {
    adapter.setStageCacheAllowed(!device.memoryConstrained);
  }, [adapter, device.memoryConstrained]);

  /**
   * DRAG THE HANDLE DOWN TO DISMISS.
   *
   * Pointer events, not touch events, so a mouse and a stylus behave the same
   * as a finger; `setPointerCapture` keeps the gesture attached to the handle
   * even when the finger leaves it, which on a sheet being pulled toward the
   * bottom of the screen is most of the gesture.
   *
   * Upward movement is clamped to zero rather than allowed to lift the sheet:
   * a bottom sheet that can be dragged up past its own top is a sheet with no
   * defined edge. Past a third of its height — or on a fast flick, which is
   * how this gesture is actually performed — it closes; otherwise it springs
   * back, and the spring is the CSS transition, which resumes the moment the
   * inline `transition: none` is removed with the drag state.
   */
  const beginSheetDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startedAt = event.timeStamp;
    const node = event.currentTarget;
    const height = sheetRef.current?.getBoundingClientRect().height ?? 0;
    node.setPointerCapture(event.pointerId);

    let travelled = 0;
    const move = (moveEvent: PointerEvent) => {
      travelled = Math.max(0, moveEvent.clientY - startY);
      setSheetDrag(travelled);
    };
    const end = (endEvent: PointerEvent) => {
      node.releasePointerCapture?.(endEvent.pointerId);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", end);
      node.removeEventListener("pointercancel", end);
      setSheetDrag(0);
      const elapsed = Math.max(1, endEvent.timeStamp - startedAt);
      const flicked = travelled > 48 && travelled / elapsed > 0.5;
      if (flicked || (height > 0 && travelled > height / 3)) setSheet(null);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }, []);

  /**
   * Escape closes the sheet, and opening one moves focus into it.
   *
   * A dialog that declares `aria-modal` and then leaves focus on the page
   * behind is a dialog a keyboard or a screen reader never enters — the
   * skill's §10 (correct focus handling) and §12 (keyboard navigation). The
   * listener is on the document because the sheet's own contents are the
   * likeliest focus target, and a key pressed inside a field in the sheet
   * still has to reach it.
   */
  useEffect(() => {
    if (!sheet) return;
    sheetRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSheet(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  /** The one place that decides whether letting the worker go is safe. */
  const releaseSlicerWorkerIfSafe = useCallback(() => {
    // Painting only exists inside the worker's WASM heap, and the engine's
    // prepared-mesh cache would not notice it going away — see
    // sessionHasPaintRef. Memory is never worth a user's brush strokes.
    if (sessionHasPaintRef.current) return false;
    return adapter.releaseSlicerWorker();
  }, [adapter]);

  const scheduleIdleWorkerRelease = useCallback(() => {
    cancelIdleWorkerRelease();
    const delay = device.idleWorkerReleaseMs;
    if (delay === null) return;
    workerReleaseTimerRef.current = window.setTimeout(() => {
      workerReleaseTimerRef.current = null;
      releaseSlicerWorkerIfSafe();
    }, delay);
  }, [cancelIdleWorkerRelease, device.idleWorkerReleaseMs, releaseSlicerWorkerIfSafe]);

  useEffect(() => {
    // Only devices that were never given the warm kernel give it back. A
    // desktop keeps its worker across a tab switch: this used to fire for
    // everyone, which threw away the warm kernel every time the user looked at
    // another tab — the exact opposite of "desktop behaviour is unchanged".
    if (typeof document === "undefined" || !device.memoryConstrained) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      // A backgrounded tab is where a mobile OS reclaims memory, and it is the
      // moment holding a WASM heap costs the most and buys the least.
      cancelIdleWorkerRelease();
      releaseSlicerWorkerIfSafe();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [cancelIdleWorkerRelease, device.memoryConstrained, releaseSlicerWorkerIfSafe]);

  useEffect(() => cancelIdleWorkerRelease, [cancelIdleWorkerRelease]);

  // -- slicing / output ------------------------------------------------------
  const triggerSlice = useCallback((allPlates = false) => {
    // A slice is about to need the worker: never let a pending idle release
    // fire into it.
    cancelIdleWorkerRelease();
    if (status === "slicing" || plateCount === 1) {
      if (!adapter.clickControl("slice-btn")) setNotice(t.actionUnavailable);
      return;
    }
    if (!adapter.triggerSlice(allPlates ? "all" : "current")) setNotice(t.actionUnavailable);
  }, [adapter, cancelIdleWorkerRelease, plateCount, status, t.actionUnavailable]);

  const currentResultState = slicing.resultState(selectedPlate);
  const currentStale = currentResultState === "stale";
  const printReady = status !== "slicing" && status !== "error" && currentResultState === "fresh";

  const currentGcodeFile = useCallback(() => {
    const name = `LEVO-${profile.shortName}-plate-${selectedPlate + 1}.gcode`;
    return slicing.freshGcodeFile(selectedPlate, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.shortName, selectedPlate, slicing.freshGcodeFile]);

  const downloadCurrentGcode = useCallback(() => {
    const file = currentGcodeFile();
    if (!file) {
      setNotice(currentStale ? t.printStale : t.printNotReady);
      return false;
    }
    downloadBlob(file, file.name);
    setNotice("");
    return true;
  }, [currentGcodeFile, currentStale, t.printNotReady, t.printStale]);

  const shareCurrentGcode = useCallback(async () => {
    const file = currentGcodeFile();
    if (!file) {
      setNotice(currentStale ? t.printStale : t.printNotReady);
      return;
    }
    const data: ShareData = { files: [file], title: file.name };
    if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        return;
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
      }
    }
    downloadBlob(file, file.name);
    setNotice(t.shareUnavailable);
  }, [currentGcodeFile, currentStale, t.printNotReady, t.printStale, t.shareUnavailable]);

  const openPrintCenter = useCallback(() => {
    if (!printReady && !currentStale) { setNotice(t.printNotReady); return; }
    setToolTrayOpen(false);
    setSidebarOpen(false);
    setSheet("print");
  }, [currentStale, printReady, t.printNotReady]);

  const primaryAction = useCallback(() => {
    if (status === "slicing") { triggerSlice(false); return; }
    if (printReady) openPrintCenter();
    else triggerSlice(false);
  }, [openPrintCenter, printReady, status, triggerSlice]);

  // -- newly spawned objects: seat them in real free space -------------------
  //
  // The engine places anything it spawns without an explicit position from a
  // cursor that only grows and resets only when the scene empties (the code is
  // quoted in app/spawn-seating.ts). So the second copy lands at the bed edge
  // and the fourth lands in open space far past it, with room still free next
  // to the original — the "duplicate throws the copy far away" report.
  //
  // This runs on the engine's own `objects` event, so it covers every route
  // that spawns one: the toolbar button, the engine's context menu, Ctrl+K,
  // paste, and a file dropped straight onto the canvas.
  const seatNewObjectsIfNeeded = useCallback((nextIds: readonly number[]) => {
    const previous = seenObjectIdsRef.current;
    const next = new Set(nextIds);
    seenObjectIdsRef.current = next;

    // A split removes one object and adds its parts AT THEIR ORIGINAL
    // POSITIONS — that is the point of splitting, so the parts must stay put.
    // Any transition that also removed an id is therefore not a spawn.
    for (const id of previous) if (!next.has(id)) return;

    const appeared = [...next].filter((id) => !previous.has(id));
    for (const id of appeared) {
      // A returning id is a restore. Record the rest as genuinely new.
      if (everSeenObjectIdsRef.current.has(id)) return;
    }
    for (const id of next) everSeenObjectIdsRef.current.add(id);
    if (!appeared.length) return;
    // An archive import has its own multi-plate arrangement; a project restore
    // places every object at the author's own offsets. Neither is a spawn, and
    // re-seating either would throw away a layout that is already correct.
    if (orchestrator.busy || orchestrator.hasPendingArrangement) return;
    if (restoreInFlightRef.current) {
      // The one objects event a restore produces. Its positions are the
      // author's own; record the ids and leave them exactly where they are.
      restoreInFlightRef.current = false;
      return;
    }
    if (suppressSeatingRef.current) return;

    const result = seatNewObjects(adapter, {
      newIds: appeared,
      bedWidth: profile.bedWidth,
      bedDepth: profile.bedDepth,
      plateCount: plateCountRef.current,
      selectedPlate: selectedPlateRef.current,
    });
    // Nothing that did not fit was squeezed, scaled or stacked — it stays
    // where the engine put it and the user is told, rather than finding a
    // silently overlapping plate later.
    if (result.ok && result.unseatedCount) {
      setNotice(templateText(t.zipOverflow, { count: result.unseatedCount }));
    }
  }, [adapter, orchestrator, profile.bedDepth, profile.bedWidth, t.zipOverflow]);

  // -- engine event stream ---------------------------------------------------
  const handleEvent = useCallback((event: ViewportEvent) => {
    slicing.handleViewportEvent(event as SlicingViewportEvent);
    if (event.type === "objects") {
      setObjects(event.value);
      const ids = event.value.map((object) => object.id);
      orchestrator.notifyObjects(ids);
      seatNewObjectsIfNeeded(ids);
      if (event.value.length) setStatus((current) => current === "slicing" ? current : "editing");
    } else if (event.type === "plateCount") {
      plateCountRef.current = event.value;
      setPlateCount(event.value);
    } else if (event.type === "selectedPlate") {
      selectedPlateRef.current = event.value;
      setSelectedPlate(event.value);
    } else if (event.type === "paintMode") {
      // A one-way latch: entering a paint mode is the only way to make a
      // stroke, so from here on this session neither releases its worker nor
      // trusts the autosave skip.
      if (event.value !== "off") sessionHasPaintRef.current = true;
    } else if (event.type === "canvasMode") {
      setCanvasMode(event.value);
      if (event.value === "preview") setToolTrayOpen(false);
    } else if (event.type === "slicing") {
      setStatus(event.value ? "slicing" : "editing");
    } else if (event.type === "notice") {
      if (suppressNextExportNoticeRef.current && /^Saved .*3mf project/i.test(event.value)) {
        suppressNextExportNoticeRef.current = false;
        return;
      }
      setNotice(event.value);
    } else if (event.type === "error") {
      setError(event.value);
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestrator, seatNewObjectsIfNeeded, slicing.handleViewportEvent]);

  const handleSliced = useCallback((payload: SlicePayload) => {
    const outcome = slicing.handleSliced(payload);
    if (outcome.overBed) {
      setError(templateText(t.overBedError, { printer: profile.shortName }));
      setStatus("error");
      return;
    }
    setError("");
    setStatus("ready");
    scheduleIdleWorkerRelease();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.shortName, scheduleIdleWorkerRelease, slicing.handleSliced, t.overBedError]);

  /** Stable identity for the engine prop — see EXTRUDER_COLORS above. */
  const handleEngineSliced = useCallback((payload: { plate: number; stats: Record<string, unknown>; gcode: string }) => {
    handleSliced(payload as SlicePayload);
  }, [handleSliced]);

  const newProject = useCallback(() => {
    if (objects.length && !window.confirm(t.newConfirm)) return;
    slicing.clearResults();
    orchestrator.clearPendingArrangement();
    seenObjectIdsRef.current = new Set();
    everSeenObjectIdsRef.current = new Set();
    restoreInFlightRef.current = false;
    // A new project starts from the preset, not from the last project's edits.
    userEditedKeysRef.current = new Set();
    arrangeUndoRef.current = null;
    orientUndoRef.current = null;
    setOrientUndoAvailable(false);
    cutUndoRef.current = null;
    setCutUndoAvailable(false);
    setArrangeUndoAvailable(false);
    setObjects([]);
    projectFilesRef.current = [];
    setProjectId(crypto.randomUUID());
    setProjectName("LEVO Project");
    setLastAutosavedAt(null);
    setLastSavedKind(null);
    setPlateCount(1);
    setSelectedPlate(0);
    setCanvasMode("prepare");
    setNotice("");
    setError("");
    setImportProgress(null);
    setSidebarOpen(false);
    setToolTrayOpen(false);
    setHandyProjectReady(false);
    exportIntentRef.current = null;
    if (exportIntentTimerRef.current !== null) {
      window.clearTimeout(exportIntentTimerRef.current);
      exportIntentTimerRef.current = null;
    }
    // A fresh editor session must never upload into the previous project.
    persistence.unlinkRemoteProject();
    setSheet(null);
    setStatus("editing");
    setWorkspaceKey((value) => value + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects.length, orchestrator, slicing.clearResults, t.newConfirm]);

  const deleteAll = useCallback(() => {
    if (!objects.length || !window.confirm(t.deleteAllConfirm)) return;
    runTool("tool-delete-all");
  }, [objects.length, runTool, t.deleteAllConfirm]);

  // -- engine settings panels (unchanged binding) ----------------------------
  const processPanel = useMemo(() => SettingsPanel ? (
    <SettingsBook Panel={SettingsPanel} settings={settings} setSettings={setEditorSettings} builder="TabPrint::build" />
  ) : null, [SettingsPanel, setEditorSettings, settings]);

  /**
   * THE MOTION PANEL WAS NOT THE MOTION PANEL.
   *
   * `machine-lock.ts` unlocked the sixteen `machine_max_*` motion limits, and
   * they were still unreachable, because this slot was rendering the wrong
   * page of the engine's option tree. three-slicer's own type says what the
   * slot is for:
   *
   *     motionPanel?: React.ReactNode
   *       Motion-limits editor, folded into the printer card — usually
   *       `<SettingsPanel only={{builder:'TabPrinter::build_kinematics_page'}}/>`
   *
   * and `TabPrinter::build_kinematics_page` is one page, "Motion ability",
   * whose groups are Speed / Acceleration / Jerk limitation — i.e. exactly the
   * `machine_max_*` keys. What was passed instead, `TabPrinter::build_fff`, is
   * "Basic information": nozzle type, G-code flavor, extruder clearances.
   *
   * Both are rendered now rather than swapping one for the other, because the
   * 35 Basic-information options were the only place the user could reach them
   * and taking them away to fix a different bug is not a fix. Kinematics comes
   * first: it is what the slot is named for and what was missing.
   */
  const motionPanel = useMemo(() => SettingsPanel ? (
    <>
      <SettingsBook Panel={SettingsPanel} settings={settings} setSettings={setEditorSettings} builder="TabPrinter::build_kinematics_page" />
      <SettingsBook Panel={SettingsPanel} settings={settings} setSettings={setEditorSettings} builder="TabPrinter::build_fff" />
    </>
  ) : null, [SettingsPanel, setEditorSettings, settings]);

  const filamentPanel = useMemo(() => SettingsPanel ? ((filamentSettings: SlicerSettings, setFilamentSettings: Dispatch<SetStateAction<SlicerSettings>>) => (
    <SettingsBook Panel={SettingsPanel} settings={filamentSettings} setSettings={setFilamentSettings} builder="TabFilament::build" />
  )) : null, [SettingsPanel]);

  /**
   * THE ENGINE'S TREE, HELD STILL WHILE THE SHELL TICKS AROUND IT.
   *
   * `Viewport` is the engine's default export and it is a plain function
   * component — not wrapped in `memo`. React re-renders a plain child on every
   * parent render regardless of whether its props changed, and what is behind
   * this one is not a small tree: the gizmo rail, the object list, the plate
   * bar, the stats card, the slice bar, and three `SettingsBook`s whose pages
   * are the kernel's entire option surface.
   *
   * The shell re-renders far more often than any of that changes. Slice
   * progress alone is ~6 renders a second (PROGRESS_THROTTLE_MS is 160), and
   * every notice, every status label, every sheet or tool-tray toggle is
   * another. On a desktop that reconciliation is invisible. On a phone it
   * lands on the same main thread the engine is posting worker replies to,
   * while the kernel has the CPU — which is exactly when the owner reports the
   * editor going sticky.
   *
   * Hoisting the props to constants (see EXTRUDER_COLORS above) was half of
   * this and could not finish the job: identical props do not stop a plain
   * component re-rendering. An identical ELEMENT does — React bails out of a
   * subtree whose element is referentially the same as last render — so the
   * element itself is what gets cached. The dependency list is every prop
   * below, which is why it is written out rather than trimmed: a prop that
   * stops being listed is a prop the engine stops being told about.
   */
  const viewportElement = useMemo(() => Viewport ? (
    <Viewport
      key={workspaceKey}
      settings={settings}
      setSettings={setEditorSettings}
      processPanel={processPanel}
      motionPanel={motionPanel}
      filamentPanel={filamentPanel}
      panels={EDITOR_PANELS}
      features={device.memoryConstrained ? EDITOR_FEATURES_COLD : EDITOR_FEATURES_WARM}
      defaultExtruderColors={EXTRUDER_COLORS}
      onEvent={handleEvent}
      onSliced={handleEngineSliced}
      onExport={handleViewportExport}
    />
  ) : null, [
    Viewport,
    workspaceKey,
    settings,
    setEditorSettings,
    processPanel,
    motionPanel,
    filamentPanel,
    device.memoryConstrained,
    handleEvent,
    handleEngineSliced,
    handleViewportExport,
  ]);

  // -- derived display state -------------------------------------------------
  /**
   * The layer height the KERNEL will use, not the tier's nominal number.
   *
   * The header printed `QUALITY[quality].layer` — the label on the Quality
   * selector — while the engine slices `settings.layer_height`. Those agree
   * only until somebody edits the layer height, which is the first thing
   * anybody does in a slicer, and then the header confidently states a number
   * the print will not use. Reading the same value the engine reads is the
   * whole fix; `QUALITY` keeps its own layer figures for the Setup sheet,
   * where they are labels on the choices rather than a claim about the print.
   */
  const effectiveLayerHeight = useMemo(() => {
    const value = Number((settings as unknown as Record<string, unknown>).layer_height);
    return Number.isFinite(value) && value > 0 ? value : QUALITY[quality].layer;
  }, [quality, settings]);

  const displayStatus: EditorStatus = status === "ready" && !printReady ? "editing" : status;
  const statusLabel = status === "slicing"
    ? `${Math.round(slicing.progress * 100)}%`
    : printReady
      ? `${slicing.layerCount || "✓"} ${t.layers}`
      : currentStale
        ? t.stale
        : t.local;
  const freshPlateCount = useMemo(() => {
    let count = 0;
    for (let plate = 0; plate < plateCount; plate += 1) {
      if (slicing.resultState(plate) === "fresh") count += 1;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plateCount, slicing.resultState, slicing.storedPlateCount, slicing.anyFresh, slicing.anyStale]);

  const canLanConnect = nativeEnvironment.native && nativeEnvironment.capabilities.lanConnection;
  const canLanPrint = canLanConnect
    && printerStatus.connected
    && (nativeEnvironment.capabilities.packagePrintJob || nativeEnvironment.capabilities.rawGcodePrintJob)
    && nativeEnvironment.capabilities.fileTransfer
    && nativeEnvironment.capabilities.startPrint
    && printerStatus.fileTransferVerified !== false
    && (printerStatus.state === undefined || printerStatus.state === "idle")
    && printReady;

  const sheetTitle = sheet === "about" ? t.about
    : sheet === "projects" ? t.projects
      : sheet === "print" ? t.printExport
        : sheet === "connect" ? t.connectTitle
          : sheet === "cut" ? t.cutTitle
            : t.settings;

  const savedStateLabel = displaySavedKind === "full"
    ? t.savedLocalFull
    : displaySavedKind === "source-only"
      ? t.savedLocalSourceOnly
      : t.autosaved;

  return (
    <main className="studio-app">
      <StudioHeader
        t={t}
        locale={locale}
        onLocaleChange={changeLocale}
        user={user ? { displayName: user.displayName } : null}
        nativeApp={nativeEnvironment.native}
        projectName={projectName}
        objectCount={objects.length}
        selectedPlate={selectedPlate}
        plateCount={plateCount}
        status={displayStatus}
        statusLabel={statusLabel}
        profileLoading={profileLoading}
        profileVerified={profileLoadState?.verified ?? true}
        profileShortName={profile.shortName}
        qualityLayer={effectiveLayerHeight}
        engineReady={Boolean(Viewport)}
        importBusy={Boolean(importProgress)}
        printReady={printReady}
        sidebarOpen={sidebarOpen}
        onPickFiles={handlePickedFiles}
        onNewProject={newProject}
        onOpenProjects={() => void openProjects()}
        onOpenPrintCenter={openPrintCenter}
        onOpenSetup={() => setSheet("setup")}
        onOpenConnect={() => setSheet("connect")}
        onOpenAbout={() => setSheet("about")}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
      />

      <section
        className="editor-area"
        aria-busy={Boolean(importProgress)}
        onDragOverCapture={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDropCapture={handleDropFiles}
      >
        <div className="viewport-mount" ref={viewportMountRef}>
          {viewportElement ?? (
            <div className="editor-loader" aria-live="polite"><span /><strong>{t.loading}</strong><small>{profile.shortName} · {profile.bed}</small></div>
          )}
        </div>

        {Viewport && !objects.length && status !== "error" && <section className="empty-upload-card" aria-label={t.files}>
          <span className="empty-upload-icon"><Icon name="file" /></span>
          <strong>{t.files}</strong>
          <p>{t.formatsShort}</p>
          <FileSelectControl className="empty-upload-action" label={t.add} disabled={Boolean(importProgress)} onFiles={handlePickedFiles}><Icon name="plus" /><span>{t.add}</span></FileSelectControl>
          <small>{t.fileLimit}</small>
        </section>}

        {importProgress && <div className="import-progress" role="status" aria-live="polite">
          <span className="import-spinner" />
          <div><strong>{importProgress.label}</strong><small>{importProgress.extracted ? `${importProgress.extracted} ${t.objects}` : t.formatsShort}</small></div>
          <progress max="1" value={Math.max(0, Math.min(1, importProgress.ratio))} />
        </div>}

        {(error || notice) && <div className={`editor-message ${error ? "error" : "notice"}`} role={error ? "alert" : "status"}>
          <span>{error || notice}</span>
          {!error && arrangeUndoAvailable && <button className="message-action" onClick={undoArrange}>{t.arrangeUndo}</button>}
          {!error && orientUndoAvailable && <button className="message-action" onClick={undoOrient}>{t.orientUndo}</button>}
          {!error && cutUndoAvailable && <button className="message-action" onClick={undoCut}>{t.cutUndo}</button>}
          <button onClick={() => { setError(""); setNotice(""); if (status === "error") setStatus("editing"); }} aria-label={t.close}><Icon name="close" /></button>
        </div>}

        {currentStale && !error && !notice && status !== "slicing" && <div className="stale-banner" role="status">
          <Icon name="warning" /><span>{t.staleHelp}</span>
          <button onClick={() => triggerSlice(false)}>{t.slice}</button>
        </div>}

        {/* Desktop home for the shell's own actions — see .shell-actions in
            globals.css for why they need one at all. */}
        <div className="shell-actions" role="group" aria-label={t.editTools}>
          <button data-levo-action="auto-arrange-desktop" disabled={!objects.length} onClick={() => void arrangeAll()}>
            <Icon name="arrange" /><span>{t.arrange}</span>
          </button>
          <button data-levo-action="auto-orient" disabled={!objects.length || orienting} onClick={() => void orientAll()}>
            <Icon name="orient" /><span>{t.orient}</span>
          </button>
          <button data-levo-action="cut" disabled={!objects.length} onClick={openCut}>
            <Icon name="cut" /><span>{t.cut}</span>
          </button>
          {/* Saving the project belongs on the canvas, not only in the header
              and not behind a slice. The header can be lost — that is exactly
              what the owner hit — and a project is worth saving long before
              anything has been sliced. */}
          <button data-levo-action="save-project" disabled={!objects.length} onClick={saveBambuProject}>
            <Icon name="save" /><span>{t.saveProjectFile}</span>
          </button>
        </div>

        {/*
          THE TOOL TRAY, GROUPED.

          It was twenty identical tiles in one flat grid: a mode (move) sat
          beside a destructive action (delete) sat beside a history step (undo)
          sat beside an output (save), all the same size, the same weight and
          the same colour. Nothing said which of them changes the selected
          object, which changes the whole plate, and which cannot be taken
          back. The apple-design skill asks for hierarchy from proximity before
          boxes (§4) and for competing emphasis to be removed (§15); a flat
          grid of twenty serves neither.

          Five groups now, each with a quiet label, in the order a print is
          actually made: put something on the bed, shape it, lay the plate out,
          look at it, then keep it. Destructive actions are the only ones that
          carry colour, and they sit at the end of their own group rather than
          in the middle of the grid where a thumb lands by accident.

          NOTHING WAS DROPPED. Every control that was in the flat grid is still
          here, and two that were reachable on a desktop and NOWHERE on a phone
          have been added: "new project" (the header button that carries it is
          display:none below 900px) and the language switch (removed outright
          below 350px, which locked a small phone to whatever locale happened
          to be stored).
        */}
        {toolTrayOpen && <section className="mobile-tooltray" aria-label={t.editTools}>
          <header><span><strong>{t.editTools}</strong><small>{t.editToolsHelp}</small></span><button onClick={() => setToolTrayOpen(false)} aria-label={t.close}><Icon name="close" /></button></header>

          <div className="toolgroup" role="group" aria-label={t.files}>
            <p className="toolgroup-label">{t.files}</p>
            <div className="mobile-toolgrid">
              <FileSelectControl className="tool-upload-action" label={t.add} disabled={!Viewport || Boolean(importProgress)} onFiles={handlePickedFiles}><Icon name="file" /><span>{t.add}</span></FileSelectControl>
              <button onClick={() => { void openProjects(); setToolTrayOpen(false); }}><Icon name="layers" /><span>{t.projects}</span></button>
              <button onClick={() => { newProject(); setToolTrayOpen(false); }}><Icon name="plus" /><span>{t.newProject}</span></button>
            </div>
          </div>

          <div className="toolgroup" role="group" aria-label={t.editTools}>
            <p className="toolgroup-label">{t.tools}</p>
            <div className="mobile-toolgrid">
              <button onClick={() => runTool("gizmo-move")}><Icon name="move" /><span>{t.move}</span></button>
              <button onClick={() => runTool("gizmo-rotate")}><Icon name="rotate" /><span>{t.rotate}</span></button>
              <button onClick={() => runTool("gizmo-scale")}><Icon name="scale" /><span>{t.scale}</span></button>
              <button onClick={() => runTool("gizmo-paint")}><Icon name="paint" /><span>{t.paint}</span></button>
              <button onClick={() => runTool("tool-duplicate")}><Icon name="copy" /><span>{t.duplicate}</span></button>
              <button onClick={() => runTool("tool-split")}><Icon name="split" /><span>{t.split}</span></button>
              <button onClick={() => runTool("tool-onbed")}><Icon name="bed" /><span>{t.onBed}</span></button>
              <button className="danger" onClick={() => runTool("tool-delete")}><Icon name="trash" /><span>{t.remove}</span></button>
            </div>
          </div>

          <div className="toolgroup" role="group" aria-label={t.arrange}>
            <p className="toolgroup-label">{t.plate}</p>
            <div className="mobile-toolgrid">
              <button onClick={() => void arrangeAll()}><Icon name="arrange" /><span>{t.arrange}</span></button>
              <button data-levo-action="auto-orient-tray" disabled={orienting} onClick={() => void orientAll()}><Icon name="orient" /><span>{t.orient}</span></button>
              <button data-levo-action="cut-tray" onClick={openCut}><Icon name="cut" /><span>{t.cut}</span></button>
              <button onClick={() => { clickControl("plate-add"); setToolTrayOpen(false); }}><Icon name="layers" /><span>{t.addPlate}</span></button>
              <button className="danger" onClick={deleteAll}><Icon name="trash" /><span>{t.deleteAll}</span></button>
            </div>
          </div>

          <div className="toolgroup" role="group" aria-label={t.preview}>
            <p className="toolgroup-label">{t.preview}</p>
            <div className="mobile-toolgrid">
              <button onClick={() => { shortcut("z"); setToolTrayOpen(false); }}><Icon name="fit" /><span>{t.fit}</span></button>
              <button onClick={() => { shortcut("b"); setToolTrayOpen(false); }}><Icon name="bed" /><span>{t.bed}</span></button>
              <button onClick={() => { clickControl("undo"); setToolTrayOpen(false); }}><Icon name="undo" /><span>{t.undo}</span></button>
              <button onClick={() => { clickControl("redo"); setToolTrayOpen(false); }}><Icon name="redo" /><span>{t.redo}</span></button>
            </div>
          </div>

          <div className="toolgroup" role="group" aria-label={t.save}>
            <p className="toolgroup-label">{t.printExport}</p>
            <div className="mobile-toolgrid">
              <button onClick={() => { saveBambuProject(); setToolTrayOpen(false); }}><Icon name="save" /><span>{t.save}</span></button>
              {plateCount > 1 && <button onClick={() => { triggerSlice(true); setToolTrayOpen(false); }}><Icon name="slice" /><span>{t.sliceAll}</span></button>}
              <button onClick={() => { openPrintCenter(); setToolTrayOpen(false); }}><Icon name="print" /><span>{t.printExport}</span></button>
            </div>
          </div>

          {/*
            THE LANGUAGE, WHERE A SMALL PHONE CAN REACH IT.

            The header's <select> is the only locale switcher in the app and it
            is removed outright below 350px, so a 320px phone was locked to
            whatever locale was persisted — in an app whose whole point is that
            it speaks Arabic, English and Kurdish. Here it is a segmented
            control rather than a select: three fixed choices are a segmented
            control's exact job, and it needs no native picker on a phone.
          */}
          <div className="toolgroup" role="group" aria-label={t.language}>
            <p className="toolgroup-label">{t.language}</p>
            <div className="locale-segments" role="radiogroup" aria-label={t.language}>
              {LOCALE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  role="radio"
                  aria-checked={locale === option.id}
                  className={locale === option.id ? "active" : ""}
                  onClick={() => changeLocale(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>}

        <div className="mobile-primarybar">
          <FileSelectControl className="mobile-nav-item" label={t.files} disabled={!Viewport || Boolean(importProgress)} onFiles={handlePickedFiles}><Icon name="file" /><span>{t.files}</span></FileSelectControl>
          <button className={`mobile-nav-item ${toolTrayOpen ? "active" : ""}`} onClick={() => { setSidebarOpen(false); setToolTrayOpen((value) => !value); }} aria-expanded={toolTrayOpen}><Icon name="move" /><span>{t.tools}</span></button>
          <button className={`mobile-primary-action ${status === "slicing" ? "cancel" : ""} ${printReady ? "ready" : ""}`} onClick={primaryAction} disabled={!objects.length}>
            <Icon name={printReady ? "print" : "slice"} /><span>{status === "slicing" ? `${t.cancel} ${Math.round(slicing.progress * 100)}%` : printReady ? t.print : t.slice}</span>
          </button>
          <button className={`mobile-nav-item ${canvasMode === "preview" ? "active" : ""}`} onClick={() => clickControl(canvasMode === "preview" ? "mode-prepare" : "mode-preview")} disabled={!objects.length}><Icon name="layers" /><span>{canvasMode === "preview" ? t.prepare : t.preview}</span></button>
          <button className={`mobile-nav-item ${sidebarOpen ? "active" : ""}`} onClick={() => { setToolTrayOpen(false); setSidebarOpen((value) => !value); }}><Icon name="settings" /><span>{t.settings}</span></button>
        </div>
      </section>

      {/*
        THE SHEET'S DISMISS PATHS, ALL THREE OF THEM REAL.

        The bar across the top of a bottom sheet is a learned affordance: on a
        phone it means "drag me down". This one was a decorative div with no
        pointer handlers at all, so the gesture every user tries first did
        nothing — the apple-design skill's §2 (agency: the user must understand
        what will happen) and §10 (an obvious dismiss path) both fail on a
        control that lies about what it does.

        It drags now, and the two dismissals that were missing are here too:
        Escape, and focus that starts inside the dialog rather than wherever it
        happened to be on the page behind. `aria-modal` was already claimed;
        this is the behaviour that claim implies.
      */}
      {sheet && <div className="sheet-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setSheet(null); }}>
        <section
          ref={sheetRef}
          className="studio-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={sheetTitle}
          tabIndex={-1}
          style={sheetDrag > 0 ? { transform: `translateY(${sheetDrag}px)`, transition: "none" } : undefined}
        >
          <div
            className="sheet-handle"
            role="button"
            tabIndex={0}
            aria-label={t.close}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSheet(null); } }}
            onPointerDown={beginSheetDrag}
          />
          <header>
            <div><strong>{sheetTitle}</strong><span>{profile.shortName} · {profile.nozzle.toFixed(1)} mm · PLA</span></div>
            <button onClick={() => setSheet(null)} aria-label={t.close}><Icon name="close" /></button>
          </header>

          {sheet === "cut" ? (
            <CutSheet
              t={t}
              min={cutBounds.min}
              max={cutBounds.max}
              offset={cutOffset}
              onOffset={setCutOffset}
              keep={cutKeep}
              onKeep={setCutKeep}
              cap={cutCap}
              onCap={setCutCap}
              busy={cutting}
              onCut={applyCut}
            />
          ) : sheet === "setup" ? (
            <SetupSheet
              t={t}
              profileId={profileId}
              quality={quality}
              strength={strength}
              support={support}
              profileVerified={profileLoading ? null : (profileLoadState?.verified ?? null)}
              missingPresets={profileLoadState?.missingPresets ?? []}
              onProfile={setProfileId}
              onQuality={setQuality}
              onStrength={setStrength}
              onSupport={setSupport}
              onOpenAdvanced={() => { setSheet(null); setSidebarOpen(true); }}
              onClose={() => setSheet(null)}
            />
          ) : sheet === "projects" ? (
            <div className="sheet-body projects-body">
              <label className="project-name-editor">
                <span>{t.projectName}</span>
                <input value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} />
                <small>{displaySavedAt ? `${savedStateLabel} · ${new Date(displaySavedAt).toLocaleTimeString(dateLocaleFor(locale))}` : t.guestSyncHint}</small>
              </label>
              <ProjectsPanel
                locale={locale}
                user={user?.id ? { id: user.id, displayName: user.displayName } : null}
                namespace={persistence.namespace}
                activeRemoteProjectId={persistence.state.remoteProjectId}
                activeDraftId={projectId}
                syncState={persistence.state}
                onOpenRemote={(project) => void openAccountProjectInEditor(project)}
                onOpenDraft={(draft) => void restoreProjectRecord(draft)}
                onCreate={createAccountProject}
                onImportLegacy={persistence.importLegacyDraftProject}
                listLegacyDrafts={persistence.listLegacyDraftProjects}
                onRequestSignIn={() => window.location.assign(SIGN_IN_HREF)}
              />
            </div>
          ) : sheet === "print" ? (
            <PrintSheet
              t={t}
              profileShortName={profile.shortName}
              selectedPlate={selectedPlate}
              objectCount={objects.length}
              freshPlateCount={freshPlateCount}
              currentStale={currentStale}
              handyProjectReady={handyProjectReady}
              onPrepareForHandy={prepareForBambuHandy}
              onDownloadGcode={() => { downloadCurrentGcode(); }}
              onShareGcode={() => void shareCurrentGcode()}
              onSaveProject={saveBambuProject}
              onExportAll={() => clickControl("export-all")}
              onOpenConnect={() => setSheet("connect")}
            />
          ) : sheet === "connect" ? (
            <ConnectSheet
              t={t}
              profileModel={profile.model}
              profileShortName={profile.shortName}
              selectedPlate={selectedPlate}
              objectCount={objects.length}
              printReady={printReady}
              handyProjectReady={handyProjectReady}
              nativeEnvironment={nativeEnvironment}
              lanAction={lanAction}
              lanIp={lanIp}
              lanAccessCode={lanAccessCode}
              lanSerial={lanSerial}
              onLanIp={setLanIp}
              onLanAccessCode={setLanAccessCode}
              onLanSerial={setLanSerial}
              discoveredPrinters={discoveredPrinters}
              printerStatus={printerStatus}
              lanMessage={lanMessage}
              lanTransferProgress={lanTransferProgress}
              canLanConnect={canLanConnect}
              canLanPrint={canLanPrint}
              onDiscoverLan={() => void discoverLan()}
              onConnectLan={() => void connectLan()}
              onDisconnectLan={() => void disconnectLan()}
              onSendLanPrint={() => { if (lanAction === "idle") void transmitNativePrint(); }}
              onPrepareForHandy={prepareForBambuHandy}
              onDownloadGcode={() => { downloadCurrentGcode(); }}
            />
          ) : (
            <AboutSheet t={t} onOpenConnect={() => setSheet("connect")} />
          )}
        </section>
      </div>}
    </main>
  );
}
