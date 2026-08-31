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
import { arrangeCurrentObjects, createEngineAdapter, seatNewObjects, type EngineTestId } from "./engine-adapter";
import { currentDeviceProfile } from "./device-profile";
import { createImportOrchestrator, ImportError, type ImportNotice, type ImportProgressUpdate } from "./import-orchestrator";
import { useSlicingState, type SlicePayload, type SlicingViewportEvent } from "./hooks/use-slicing-state";
import { EDITOR_SHADOW_CSS } from "./editor-theme";
import { fallbackMachineSettings, loadPrinterProfile, type MissingPreset } from "./profile-loader";
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
import type {
  OpenedRemoteProject,
  ProjectManifest,
  RemoteProjectSummary,
  SnapshotCapture,
} from "./project-sync";
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
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

type Sheet = "setup" | "projects" | "print" | "connect" | "about" | null;
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

export default function SlicerClient({ user = null }: { user?: { id?: string; displayName: string } | null }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [sheet, setSheet] = useState<Sheet>(null);
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
  const exportIntentRef = useRef<"bambu-handy" | "persist" | null>(null);
  const snapshotResolverRef = useRef<((file: File | null) => void) | null>(null);
  const exportIntentTimerRef = useRef<number | null>(null);
  const suppressNextExportNoticeRef = useRef(false);
  const restoredSettingsRef = useRef<{ key: string; settings: SlicerSettings } | null>(null);
  const machineRef = useRef<SlicerSettings>(fallbackMachineSettings(PROFILES[DEFAULT_PROFILE_ID]));
  const machineKeysRef = useRef<string[]>([]);
  const projectFilesRef = useRef<File[]>([]);
  const arrangeUndoRef = useRef<(() => boolean) | null>(null);
  const plateCountRef = useRef(1);
  const selectedPlateRef = useRef(0);
  /** Object ids the shell has already seen, so it can tell a spawn from a split. */
  const seenObjectIdsRef = useRef<Set<number>>(new Set());
  /**
   * Set while the shell itself is placing objects — an undo restore, a project
   * open, a new project. Those already carry exact positions, so the
   * free-space seating must keep its hands off them.
   */
  const suppressSeatingRef = useRef(false);
  /** Pending idle release of the engine's slice worker (constrained devices). */
  const workerReleaseTimerRef = useRef<number | null>(null);
  const suppressSeatingTimerRef = useRef<number | null>(null);

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

  useEffect(() => () => {
    if (exportIntentTimerRef.current !== null) window.clearTimeout(exportIntentTimerRef.current);
  }, []);

  // -- profile / preset loading (honest missing-preset reporting) ------------
  useEffect(() => {
    const requestId = profileRequestRef.current + 1;
    profileRequestRef.current = requestId;
    setProfileLoadState(null);
    loadPrinterProfile(profile, quality, strength, support)
      .then((loaded) => {
        if (profileRequestRef.current !== requestId) return;
        machineRef.current = loaded.machine;
        machineKeysRef.current = loaded.machineKeys;
        const restored = restoredSettingsRef.current?.key === requestedPresetKey ? restoredSettingsRef.current.settings : null;
        if (restored) restoredSettingsRef.current = null;
        setSettings(restored ?? loaded.settings);
        setProfileLoadState({ verified: loaded.verified, missingPresets: loaded.missingPresets });
        slicing.clearResults();
        setHandyProjectReady(false);
        setLoadedPresetKey(requestedPresetKey);
        setNotice("");
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
      const locked = { ...proposed };
      const lockedRecord = locked as Record<string, unknown>;
      const machineRecord = machineRef.current as Record<string, unknown>;
      for (const key of machineKeysRef.current) {
        if (Object.prototype.hasOwnProperty.call(machineRecord, key)) lockedRecord[key] = machineRecord[key];
        else delete lockedRecord[key];
      }
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
    setArrangeUndoAvailable(Boolean(result.undo));
    const messages = [templateText(t.arrangeDone, { models: result.arrangedCount, plates: Math.max(1, result.platesUsed) })];
    if (result.oversizedCount) messages.push(templateText(t.zipOversized, { count: result.oversizedCount }));
    if (result.overflowCount) messages.push(templateText(t.zipOverflow, { count: result.overflowCount }));
    setNotice(messages.join(" "));
  }, [adapter, objects.length, profile.bedDepth, profile.bedWidth, selectedPlate, t.arrangeDone, t.arrangeUnavailable, t.zipOverflow, t.zipOversized]);

  const undoArrange = useCallback(() => {
    const undo = arrangeUndoRef.current;
    arrangeUndoRef.current = null;
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
    suppressSeating();
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
  }, [adapter, orchestrator, requestedPresetKey, suppressSeating, t.engineUnavailable, t.savedLocalFull, t.savedLocalSourceOnly]);

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
  const handleViewportExport = useCallback<NonNullable<ViewportProps["onExport"]>>((file, filename) => {
    const intent = exportIntentRef.current;
    if (!intent || !filename.toLowerCase().endsWith(".3mf")) return;
    exportIntentRef.current = null;
    if (exportIntentTimerRef.current !== null) {
      window.clearTimeout(exportIntentTimerRef.current);
      exportIntentTimerRef.current = null;
    }
    if (intent === "persist") {
      // Engine snapshot capture for the S5 sync layer (captureEngineSnapshot).
      const safeName = (projectName.trim() || "LEVO Project").replace(/[^\p{L}\p{N}._-]+/gu, "-");
      const snapshot = new File([file], `${safeName}.3mf`, { type: "model/3mf", lastModified: Date.now() });
      projectFilesRef.current = [snapshot];
      suppressNextExportNoticeRef.current = true;
      snapshotResolverRef.current?.(snapshot);
    } else {
      const phoneFilename = `LEVO-${profile.shortName}-Bambu-Handy.3mf`;
      downloadBlob(file, phoneFilename);
      setHandyProjectReady(true);
      setNotice(t.handyFileReady);
    }
    return true;
  }, [profile.shortName, projectName, t.handyFileReady]);

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

  const scheduleIdleWorkerRelease = useCallback(() => {
    cancelIdleWorkerRelease();
    const delay = device.idleWorkerReleaseMs;
    if (delay === null) return;
    workerReleaseTimerRef.current = window.setTimeout(() => {
      workerReleaseTimerRef.current = null;
      adapter.releaseSlicerWorker();
    }, delay);
  }, [adapter, cancelIdleWorkerRelease, device.idleWorkerReleaseMs]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      // A backgrounded tab is where a mobile OS reclaims memory, and it is the
      // moment holding a WASM heap costs the most and buys the least.
      cancelIdleWorkerRelease();
      adapter.releaseSlicerWorker();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [adapter, cancelIdleWorkerRelease]);

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
    if (!appeared.length) return;
    // An archive import has its own multi-plate arrangement; a project restore
    // places every object at the author's own offsets. Neither is a spawn, and
    // re-seating either would throw away a layout that is already correct.
    if (orchestrator.busy || orchestrator.hasPendingArrangement) return;
    if (suppressSeatingRef.current) {
      // Objects are still arriving from the restore. Hold the window open —
      // a large 3MF can take longer to parse than the timer, and letting it
      // expire mid-import would seat the remaining objects and destroy the
      // author's layout for exactly the projects that need it most.
      suppressSeating();
      return;
    }

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
  }, [adapter, orchestrator, profile.bedDepth, profile.bedWidth, suppressSeating, t.zipOverflow]);

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
    arrangeUndoRef.current = null;
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

  const motionPanel = useMemo(() => SettingsPanel ? (
    <SettingsBook Panel={SettingsPanel} settings={settings} setSettings={setEditorSettings} builder="TabPrinter::build_fff" />
  ) : null, [SettingsPanel, setEditorSettings, settings]);

  const filamentPanel = useMemo(() => SettingsPanel ? ((filamentSettings: SlicerSettings, setFilamentSettings: Dispatch<SetStateAction<SlicerSettings>>) => (
    <SettingsBook Panel={SettingsPanel} settings={filamentSettings} setSettings={setFilamentSettings} builder="TabFilament::build" />
  )) : null, [SettingsPanel]);

  // -- derived display state -------------------------------------------------
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
        qualityLayer={QUALITY[quality].layer}
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
          {Viewport ? (
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
          ) : (
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
          <button onClick={() => { setError(""); setNotice(""); if (status === "error") setStatus("editing"); }} aria-label={t.close}><Icon name="close" /></button>
        </div>}

        {currentStale && !error && !notice && status !== "slicing" && <div className="stale-banner" role="status">
          <Icon name="warning" /><span>{t.staleHelp}</span>
          <button onClick={() => triggerSlice(false)}>{t.slice}</button>
        </div>}

        {toolTrayOpen && <section className="mobile-tooltray" aria-label={t.editTools}>
          <header><span><strong>{t.editTools}</strong><small>{t.editToolsHelp}</small></span><button onClick={() => setToolTrayOpen(false)} aria-label={t.close}><Icon name="close" /></button></header>
          <div className="mobile-toolgrid">
            <FileSelectControl className="tool-upload-action" label={t.add} disabled={!Viewport || Boolean(importProgress)} onFiles={handlePickedFiles}><Icon name="file" /><span>{t.add}</span></FileSelectControl>
            <button onClick={() => runTool("gizmo-move")}><Icon name="move" /><span>{t.move}</span></button>
            <button onClick={() => runTool("gizmo-rotate")}><Icon name="rotate" /><span>{t.rotate}</span></button>
            <button onClick={() => runTool("gizmo-scale")}><Icon name="scale" /><span>{t.scale}</span></button>
            <button onClick={() => runTool("tool-duplicate")}><Icon name="copy" /><span>{t.duplicate}</span></button>
            <button className="danger" onClick={() => runTool("tool-delete")}><Icon name="trash" /><span>{t.remove}</span></button>
            <button onClick={() => runTool("tool-split")}><Icon name="split" /><span>{t.split}</span></button>
            <button onClick={() => runTool("tool-onbed")}><Icon name="bed" /><span>{t.onBed}</span></button>
            <button onClick={() => runTool("gizmo-paint")}><Icon name="paint" /><span>{t.paint}</span></button>
            <button onClick={() => void arrangeAll()}><Icon name="arrange" /><span>{t.arrange}</span></button>
            <button onClick={() => { shortcut("z"); setToolTrayOpen(false); }}><Icon name="fit" /><span>{t.fit}</span></button>
            <button onClick={() => { shortcut("b"); setToolTrayOpen(false); }}><Icon name="bed" /><span>{t.bed}</span></button>
            <button onClick={() => { clickControl("undo"); setToolTrayOpen(false); }}><Icon name="undo" /><span>{t.undo}</span></button>
            <button onClick={() => { clickControl("redo"); setToolTrayOpen(false); }}><Icon name="redo" /><span>{t.redo}</span></button>
            <button onClick={() => { clickControl("plate-add"); setToolTrayOpen(false); }}><Icon name="layers" /><span>{t.addPlate}</span></button>
            <button onClick={() => { clickControl("save-project"); setToolTrayOpen(false); }}><Icon name="save" /><span>{t.save}</span></button>
            {plateCount > 1 && <button onClick={() => { triggerSlice(true); setToolTrayOpen(false); }}><Icon name="slice" /><span>{t.sliceAll}</span></button>}
            <button className="danger" onClick={deleteAll}><Icon name="trash" /><span>{t.deleteAll}</span></button>
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

      {sheet && <div className="sheet-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setSheet(null); }}>
        <section className="studio-sheet" role="dialog" aria-modal="true" aria-label={sheetTitle}>
          <div className="sheet-handle" />
          <header>
            <div><strong>{sheetTitle}</strong><span>{profile.shortName} · {profile.nozzle.toFixed(1)} mm · PLA</span></div>
            <button onClick={() => setSheet(null)} aria-label={t.close}><Icon name="close" /></button>
          </header>

          {sheet === "setup" ? (
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
              onSaveProject={() => clickControl("save-project")}
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
