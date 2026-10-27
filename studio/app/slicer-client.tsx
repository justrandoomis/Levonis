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
 *   the tree but remain capability-gated and unreachable on the web;
 * - below 900px the phone shell of plan item C6 (components/mobile/*): one
 *   scrolling column of clay cards around the SAME engine mount the desktop
 *   uses, so crossing 900px never rebuilds the engine (globals.css, THE PHONE
 *   SHELL); a device-local light/dark theme (app/theme.ts).
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
  applyOrientationPreset, arrangeCurrentObjects, autoOrientObjects, createEngineAdapter, cutObject, cutRange, isHeavyImport, seatNewObjects,
  type CutKeep, type EngineTestId,
} from "./engine-adapter";
import { currentDeviceProfile } from "./device-profile";
import { createImportOrchestrator, ImportError, MODEL_FILE_BYTES_CEILING, oversizedModelFiles, type ImportNotice, type ImportProgressUpdate } from "./import-orchestrator";
import { useSlicingState, type SlicePayload, type SlicingViewportEvent } from "./hooks/use-slicing-state";
import { EDITOR_SHADOW_CSS } from "./editor-theme";
import { fallbackMachineSettings, loadPrinterProfile, type MissingPreset } from "./profile-loader";
import { applyMachineLock } from "./machine-lock";
import { carryUserEdits, keysAwayFromPreset, recordEdits, recordEngineWrites, type PresetSelection } from "./settings-carryover";
import {
  DEFAULT_INFILL_ID,
  DEFAULT_MATERIAL_ID,
  DEFAULT_PROFILE_ID,
  INFILL,
  MATERIALS,
  PROFILES,
  QUALITY,
  STRENGTH,
  availableMaterial,
  isInfillId,
  isMaterialId,
  materialInForce,
  materialsFor,
  isProfileId,
  printerChoiceAnswered,
  readStoredProfileId,
  storePrinterChoiceDeclined,
  storeProfileId,
  type InfillId,
  type ListedFilamentPresets,
  type MaterialId,
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
import { useStudioMode } from "./hooks/use-studio-mode";
import { useStudioTheme } from "./hooks/use-studio-theme";
import { createDimensionCache, formatDimensions, objectsOffBed } from "./model-dimensions";
import { currentPreset, type OrientationPreset, type Vec3 } from "./auto-orient";
import { runPreflight } from "./makerworld/preflight";
import { localizeEngineMessage } from "./engine-messages";
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

/**
 * How long the "loading into the editor" row may stay up with no objects
 * event. A backstop against a lost event, not a deadline for the import.
 */
const IMPORT_WAIT_CEILING_MS = 120_000;

import type {
  OpenedRemoteProject,
  ProjectManifest,
  RemoteProjectSummary,
  RemoteRevision,
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
import StudioHeader, { FileSelectControl, Icon, SIGN_IN_HREF, SIGN_OUT_HREF } from "./components/header";
import SignOutSheet from "./components/sheets/sign-out";
import SetupSheet from "./components/sheets/setup";
import PrinterChoiceSheet from "./components/sheets/printer-choice";
import PrintSheet from "./components/sheets/print";
import ConnectSheet, { type LanAction } from "./components/sheets/connect";
import AboutSheet from "./components/sheets/about";
import CutSheet from "./components/sheets/cut";
import StudioTopBar from "./components/mobile/top-bar";
import ModeSegmented from "./components/mobile/mode-segmented";
import ViewportCard from "./components/mobile/viewport-card";
import TransformToolBar, { type GizmoTool } from "./components/mobile/transform-tool-bar";
import PrintSettingsCard from "./components/mobile/print-settings-card";
import ModelInfoCard from "./components/mobile/model-info-card";
import ReadinessBanner from "./components/mobile/readiness-banner";
import { readinessOf } from "./components/mobile/readiness";
import PrimarySliceButton from "./components/mobile/primary-slice-button";
import ExportSection from "./components/mobile/export-section";
import OverflowSheet, { type OverflowAction } from "./components/mobile/overflow-sheet";

type Sheet = "setup" | "printer" | "projects" | "print" | "connect" | "about" | "cut" | "signout" | "more" | null;
type EditorStatus = "loading" | "editing" | "slicing" | "ready" | "error";
type CanvasMode = "prepare" | "preview";

interface ImportProgressState {
  label: string;
  ratio: number;
  extracted: number;
  /**
   * True for the stretch that has no measurable progress: the engine is
   * building the mesh and does not report how far along it is. The row still
   * shows, with a bar that says "working" rather than a percentage that would
   * have to be invented.
   */
  indeterminate?: boolean;
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

/** What Tab can land on inside an open sheet (the wrap at its two ends). */
const SHEET_TABBABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

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
 * The engine's print estimate (seconds), in the reader's words: «ساعتين
 * و5 دقائق», "2 h 5 min". Latin digits, as every readout in the Studio; the
 * Arabic noun takes its counted form (i18n templateText).
 */
function formatDuration(seconds: number, t: { durationHours: string; durationMinutes: string }, locale: Locale): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? templateText(t.durationHours, { h: hours, m: minutes % 60 }, locale)
    : templateText(t.durationMinutes, { m: minutes }, locale);
}

/**
 * Turn an opened account revision into the editor's restore record. Shared
 * by "open project" (the head, linked) and the history's "open as a copy"
 * (a kept revision, NOT linked — see openRevisionCopyInEditor).
 */
function recordFromOpened(opened: OpenedRemoteProject, id: string, name: string): StoredLevoProject {
  const manifest = opened.manifest;
  const manifestProfile = manifest?.printer?.profileId;
  return {
    id,
    name,
    updatedAt: Date.now(),
    files: opened.files,
    profileId: typeof manifestProfile === "string" ? manifestProfile : DEFAULT_PROFILE_ID,
    quality: typeof manifest?.settings?.quality === "string" ? manifest.settings.quality : "standard",
    strength: typeof manifest?.settings?.strength === "string" ? manifest.settings.strength : "standard",
    support: Boolean(manifest?.settings?.support),
    infill: typeof manifest?.settings?.infill === "string" ? manifest.settings.infill : undefined,
    material: typeof manifest?.settings?.material === "string" ? manifest.settings.material : undefined,
    settings: manifest?.settings?.global as SlicerSettings | undefined,
    objectCount: manifest?.objects?.length,
    plateCount: manifest?.plates?.count,
    snapshotVersion: opened.snapshotKind === "full" ? 2 : undefined,
    snapshotKind: opened.snapshotKind ?? "source-only",
  };
}

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
  /** True while a press that began on the backdrop itself is in progress. */
  const backdropPressRef = useRef(false);
  const [profileId, setProfileId] = useState<ProfileId>(DEFAULT_PROFILE_ID);
  const [quality, setQuality] = useState<QualityId>("standard");
  const [strength, setStrength] = useState<StrengthId>("standard");
  const [infill, setInfill] = useState<InfillId>(DEFAULT_INFILL_ID);
  const [support, setSupport] = useState(false);
  /** The «الخامة» row: only materials whose engine preset ships for this printer. */
  const [material, setMaterial] = useState<MaterialId>(DEFAULT_MATERIAL_ID);
  /**
   * A tap on the material the selector already holds while T1 holds another
   * filament (one an imported project brought): the counter runs the preset
   * effect again, and the ref tells it to carry the reload as a material
   * change, so the row takes T1 back (chooseMaterial).
   */
  const [materialTakeBack, setMaterialTakeBack] = useState(0);
  const materialTakeBackRef = useRef(false);
  /**
   * THE FIRST-RUN PRINTER QUESTION.
   *
   * `printerAsk` is true only while the question is open and unanswered; the
   * draft is what has been tapped so far, and is deliberately null to start —
   * see components/sheets/printer-choice.tsx for why nothing is pre-selected.
   */
  const [printerAsk, setPrinterAsk] = useState(false);
  const [printerDraft, setPrinterDraft] = useState<ProfileId | null>(null);
  // Fallback machine numbers until the async preset load resolves; the honest
  // verified/missing state comes from profileLoadState, never from this seed.
  const [settings, setSettings] = useState<SlicerSettings>(() => fallbackMachineSettings(PROFILES[DEFAULT_PROFILE_ID]));
  const [loadedPresetKey, setLoadedPresetKey] = useState("");
  // The listed materials' filament presets, which the «الخامة» row compares T1 with.
  const [listedFilaments, setListedFilaments] = useState<ListedFilamentPresets>({});
  const [profileLoadState, setProfileLoadState] = useState<ProfileLoadState | null>(null);
  const [status, setStatus] = useState<EditorStatus>("loading");
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("prepare");
  const [objects, setObjects] = useState<Array<{ id: number; name: string; extruder: number; visible: boolean }>>([]);
  const [plateCount, setPlateCount] = useState(1);
  const [selectedPlate, setSelectedPlate] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  /**
   * WARNINGS THE ENGINE KEEPS ONLY IN ITS SIDE PANEL. Simple hides that panel
   * at every width, and neither of these is an engine event, so the shell
   * carries both itself, in BOTH modes:
   *  - the slow-slice warning when one import adds more than the engine's own
   *    triangle threshold (app/engine-adapter.ts HEAVY_IMPORT_TRIANGLES);
   *  - the engine's "simplified retry" offer after a failed slice: the error
   *    TEXT it belongs to (the error row offers the retry only beside that
   *    error) and the shell clicks the engine's own button through the adapter.
   */
  const [heavyImportTriangles, setHeavyImportTriangles] = useState<number | null>(null);
  const [downgradeOfferFor, setDowngradeOfferFor] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * THE PHONE SHELL'S OWN STATE (plan item C6).
   *
   * `viewportExpanded` is the in-app full-height viewport behind the card's
   * expand button (there is no Fullscreen API on an iPhone). `activeGizmo`
   * is which transform tile is pressed; it is re-read from the engine's own
   * rail after every tile tap, objects event and scene gesture, because a
   * keyboard shortcut can change it behind the shell's back. `sceneTick`
   * makes the size readout, the orientation chips and the file chip re-read
   * the scene, which emits no event of its own when a transform changes.
   */
  const [viewportExpanded, setViewportExpanded] = useState(false);
  const [activeGizmo, setActiveGizmo] = useState<GizmoTool | null>("move");
  const [sceneTick, setSceneTick] = useState(0);
  const [saving, setSaving] = useState(false);
  /** What the last automatic orient wrote per object: the «تلقائي» chip reads it. */
  const [autoRotations, setAutoRotations] = useState<ReadonlyMap<number, Vec3>>(() => new Map());
  const [dimensionCache] = useState(createDimensionCache);
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
  /** The map the last preset load built: an edit back to it is no edit. */
  const loadedPresetRef = useRef<SlicerSettings | null>(null);
  /**
   * The keys the engine or an imported file set away from that preset, which
   * nobody typed: a 3MF's own layer height, the filament list spread over the
   * AMS slots. Carried silently by the next selector change, never counted
   * as the person's edits (settings-carryover.ts recordEngineWrites).
   */
  const engineKeysRef = useRef<Set<string>>(new Set());
  /** The filament keys the last preset load's material carried. */
  const loadedFilamentKeysRef = useRef<readonly string[]>([]);
  /** The live settings map, for the preset effect's async continuation. */
  const settingsRef = useRef<SlicerSettings>(settings);
  const projectFilesRef = useRef<File[]>([]);
  const arrangeUndoRef = useRef<(() => boolean) | null>(null);
  const orientUndoRef = useRef<(() => boolean) | null>(null);
  const cutUndoRef = useRef<(() => boolean) | null>(null);
  /**
   * THE STRETCH THE PROGRESS ROW USED TO SKIP.
   *
   * `EngineAdapter#dispatchFiles` fires the engine's file-input change event
   * and returns — the engine STARTS reading the mesh there, it does not finish
   * there — and the orchestrator clears its progress as soon as that call
   * resolves. So for a plain STL the row appeared and vanished within a frame,
   * and the entire real wait (parse, upload to the GPU, first objects event)
   * happened over an empty bed with nothing on screen to say why.
   *
   * This holds the object count the editor had when the files went in. The
   * indicator stays up until the count grows past it — the first honest sign
   * the engine actually has the model — or until the timer below gives up.
   */
  const importWaitRef = useRef<{ baselineObjects: number } | null>(null);
  const importWaitTimerRef = useRef<number | null>(null);
  const plateCountRef = useRef(1);
  const selectedPlateRef = useRef(0);
  /** Object ids currently in the scene, so the shell can tell a spawn from a split. */
  const seenObjectIdsRef = useRef<Set<number>>(new Set());
  /** Object ids the heavy-import check has already counted. */
  const triangleCheckedIdsRef = useRef<Set<number>>(new Set());
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
  const requestedPresetKey = `${profileId}:${quality}:${strength}:${support}:${infill}:${material}`;
  const profileLoading = loadedPresetKey !== requestedPresetKey;
  /**
   * The dictionary, for the preset effect's async continuation.
   *
   * It cannot take `t` as a dependency: that would make switching language
   * reload the printer profile and throw away every slice result. A ref kept
   * current by its own effect is the same trick `plateCountRef` uses below.
   */
  const textRef = useRef(t);
  const localeRef = useRef(locale);

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
      `${profileId}:${quality}:${strength}:${support}:${infill}:${material}`,
      `plates=${plateCount}`,
      namesPart,
      adapter.sceneFingerprint(),
      settingsPart,
    ].join("|");
  }, [adapter, infill, material, objects, plateCount, profileId, projectName, quality, settings, strength, support]);

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
      settings: { quality, strength, support, infill, material, global: settings as unknown as Record<string, unknown> },
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
      infill,
      material,
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
        // The reason is the browser's or the bundler's English; the row says
        // what happened in the person's language.
        console.warn("[levo-studio] engine boot failed", reason);
        setError(textRef.current.engineBootFailed);
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

  /*
   * SIMPLE / ADVANCED (P1-10; owner decisions S6/S7).
   *
   * Simple is the default for everyone and hides the engine side panel at
   * every width plus the engine controls that do not work (the rules are in
   * app/editor-theme.ts, keyed on this host attribute). Nothing that warns or
   * prices is in that panel's way: engine errors and notices arrive as events
   * and land in the shell's own message row, the stale-result banner and the
   * slice action are the shell's, and the stats card with the over-bed
   * warning sits outside the panel — all of them identical in both modes.
   */
  const studioMode = useStudioMode(user?.id ?? null);
  const simpleMode = studioMode.mode === "simple";
  useEffect(() => {
    adapter.setHostAttribute("data-levo-mode", studioMode.mode);
  }, [adapter, studioMode.mode]);

  /*
   * THE THEME (DECISIONS row 271, D-14): system, light or dark, kept on this
   * device (app/theme.ts). The page follows `data-theme` on <html>; the
   * engine's shadow roots follow the same answer through a host attribute,
   * so its panels, plate bar and stats card change with the page. The canvas
   * itself stays the engine's dark island in both.
   */
  const studioTheme = useStudioTheme();
  useEffect(() => {
    adapter.setHostAttribute("data-levo-theme", studioTheme.resolved);
  }, [adapter, studioTheme.resolved]);
  useEffect(() => {
    adapter.setHostAttribute("data-levo-viewport", viewportExpanded ? "expanded" : "card");
  }, [adapter, viewportExpanded]);

  // -- locale ----------------------------------------------------------------
  useEffect(() => { setLocale(readStoredLocale()); }, []);
  useEffect(() => { applyLocaleToDocument(locale); }, [locale]);
  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    storeLocale(next);
  }, []);

  // -- printer (asked for on the first visit, remembered after) --------------
  /**
   * Every path that names a printer goes through here: the first-run chooser,
   * the Setup sheet, and opening a saved project. One function, so "the
   * printer is remembered" and "the question is answered" can never drift
   * apart — the bug being fixed is precisely a printer that was in force
   * without ever having been chosen.
   */
  const chooseProfile = useCallback((id: ProfileId) => {
    setProfileId(id);
    storeProfileId(id);
    setPrinterAsk(false);
    // A material the new printer has no engine preset for is not kept.
    setMaterial((current) => availableMaterial(id, current));
  }, []);

  useEffect(() => {
    const stored = readStoredProfileId();
    if (stored) {
      setProfileId(stored);
      return;
    }
    if (printerChoiceAnswered()) return;
    // Both in one effect body so they land in the same render: the dismissal
    // watcher below reads "asked, and the sheet is not open" as a dismissal.
    setPrinterAsk(true);
    setSheet("printer");
  }, []);

  /**
   * A dismissal is an answer too.
   *
   * The sheet closes by four paths — the X, the backdrop, Escape, and a drag
   * down — and all four funnel into `setSheet(null)` without passing through
   * the chooser's own button. Watching for the sheet leaving while the
   * question is still open catches every one of them, and records "asked,
   * declined" so the person is not met by the same sheet on every visit. The
   * seed profile stays in force and Settings is still there.
   */
  useEffect(() => {
    if (!printerAsk || sheet === "printer") return;
    storePrinterChoiceDeclined();
    setPrinterAsk(false);
  }, [printerAsk, sheet]);

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
  useEffect(() => { localeRef.current = locale; }, [locale]);

  useEffect(() => () => {
    if (exportIntentTimerRef.current !== null) window.clearTimeout(exportIntentTimerRef.current);
    if (importWaitTimerRef.current !== null) window.clearTimeout(importWaitTimerRef.current);
  }, []);

  // -- profile / preset loading (honest missing-preset reporting) ------------
  useEffect(() => {
    const requestId = profileRequestRef.current + 1;
    profileRequestRef.current = requestId;
    const nextSelection: PresetSelection = { printerId: profileId, quality, strength, support, infill, material };
    // The material row asked for T1 back from a filament the selector did not
    // load: the reload is carried as a material change, so the row owns T1.
    const takeBack = materialTakeBackRef.current;
    materialTakeBackRef.current = false;
    setProfileLoadState(null);
    loadPrinterProfile(profile, quality, strength, support, infill, material)
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
          // What the saved project holds beyond its preset (its file values,
          // its spread filament slots) survives the next selector change.
          engineKeysRef.current = new Set(keysAwayFromPreset(loaded.settings, restored));
          setNotice("");
        } else {
          const carried = carryUserEdits({
            loaded: loaded.settings,
            previous: settingsRef.current,
            editedKeys: userEditedKeysRef.current,
            previousSelection: takeBack && loadedSelectionRef.current
              ? { ...loadedSelectionRef.current, material: "t1-from-file" }
              : loadedSelectionRef.current,
            nextSelection,
            processKeys: loaded.processKeys,
            filamentKeys: loaded.filamentKeys,
            previousFilamentKeys: loadedFilamentKeysRef.current,
            engineKeys: engineKeysRef.current,
          });
          setSettings(carried.settings);
          userEditedKeysRef.current = new Set(carried.kept);
          engineKeysRef.current = new Set(carried.engineKept);
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
        loadedPresetRef.current = loaded.settings;
        loadedFilamentKeysRef.current = loaded.filamentKeys;
        setProfileLoadState({ verified: loaded.verified, missingPresets: loaded.missingPresets });
        slicing.clearResults();
        setHandyProjectReady(false);
        setListedFilaments(loaded.listedFilaments);
        setLoadedPresetKey(requestedPresetKey);
      })
      .catch((reason: unknown) => {
        if (profileRequestRef.current !== requestId) return;
        setListedFilaments({});
        setLoadedPresetKey(requestedPresetKey);
        setProfileLoadState({ verified: false, missingPresets: [] });
        console.warn("[levo-studio] printer profile load failed", reason);
        setError(textRef.current.profileLoadFailed);
      });
    // slicing.clearResults is identity-stable per hook instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infill, material, materialTakeBack, profile, quality, requestedPresetKey, strength, support]);

  // -- settings (engine SettingsPanel binding stays; machine keys locked) ----
  const setEditorSettings: Dispatch<SetStateAction<SlicerSettings>> = useCallback((next) => {
    // Asked now, while the event that caused this write (if any) is still
    // being handled; the updater below runs later, during the render.
    const byPerson = adapter.isPersonEditing();
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
       *
       * Only a person's own write counts (recordEdits): the engine writing
       * its filament keys back after a preset load is not an edit, and
       * counting it made every phone row say «تم الاحتفاظ بـ 12 من إعداداتك
       * المعدّلة» to someone who had edited nothing.
       */
      userEditedKeysRef.current = recordEdits({
        before: current,
        after: locked,
        preset: loadedPresetRef.current,
        edited: userEditedKeysRef.current,
        byPerson,
      });
      /*
       * And what the write moved that the person did not type (a 3MF's
       * project settings, the filament list spread over the AMS slots) is
       * remembered apart, so the next selector change carries it instead of
       * resetting it to the preset with nothing said.
       */
      engineKeysRef.current = recordEngineWrites({
        before: current,
        after: locked,
        preset: loadedPresetRef.current,
        engine: engineKeysRef.current,
        byPerson,
      });
      return locked;
    });
    // Any settings change makes stored slice results stale — never silently
    // exportable as if produced by the new settings.
    slicing.notifySettingsChanged();
    setHandyProjectReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, slicing.notifySettingsChanged]);

  // -- adapter-backed controls ----------------------------------------------
  const clickControl = useCallback((testId: EngineTestId, silent = false) => {
    const clicked = adapter.clickControl(testId);
    if (!clicked && !silent) setNotice(t.actionUnavailable);
    if (clicked) setNotice("");
    return clicked;
  }, [adapter, t.actionUnavailable]);

  const runTool = useCallback((testId: EngineTestId) => {
    void adapter.runPrepareAction(testId).then((clicked) => {
      if (!clicked) setNotice(t.actionUnavailable);
      // The engine owns which gizmo is on; read its answer, not our guess.
      setActiveGizmo((current) => adapter.activeGizmo() ?? current);
    });
  }, [adapter, t.actionUnavailable]);

  /**
   * A transform tile. The tile turns at once (the press has to answer the
   * finger), and runTool then re-reads the engine's own rail, so a tap the
   * engine refused cannot leave the wrong tile pressed.
   */
  const chooseGizmo = useCallback((tool: GizmoTool) => {
    setActiveGizmo(tool);
    runTool(tool === "move" ? "gizmo-move" : tool === "rotate" ? "gizmo-rotate" : "gizmo-scale");
  }, [runTool]);

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
      // `file-unreadable` is a file we could not READ — an iCloud file that
      // has not come down to the iPad, a revoked handle, a disconnected
      // drive — and it is named here so the owner knows WHICH one. It borrows
      // `importFailed`, whose first half («تعذر استيراد الملف») is true of it,
      // rather than inventing a sentence: the Sorani copy in this app is
      // hand-written and never generated, so a new string is the owner's to
      // word. The name is the part that makes it actionable either way.
      if (reason.code === "file-unreadable") return `${t.importFailed} ${reason.fileName ?? ""}`.trim();
      if (reason.fileName) return `${t.importFailed} ${reason.fileName}`;
      return t.importFailed;
    }
    /**
     * NEVER THE BROWSER'S OWN SENTENCE. This used to return `reason.message`,
     * and on Safari that is «Load failed» — untranslated English, in an Arabic
     * right-to-left interface, describing a network condition the customer
     * cannot act on. It reads as the site being broken, and it is what got
     * reported as a network error on a ZIP import. The raw text still goes to
     * the console, where it is useful, and the screen gets a sentence that
     * exists in all three languages.
     */
    if (reason instanceof Error) console.warn("[import]", reason);
    return t.importFailed;
  }, [t.emptyFile, t.engineUnavailable, t.importFailed, t.zipBudgetExceeded, t.zipEntryLimit, t.zipRatioLimit]);

  /** Stops the post-dispatch wait, whatever ended it. */
  const endImportWait = useCallback(() => {
    if (importWaitTimerRef.current !== null) {
      window.clearTimeout(importWaitTimerRef.current);
      importWaitTimerRef.current = null;
    }
    if (!importWaitRef.current) return;
    importWaitRef.current = null;
    setImportProgress(null);
  }, []);

  /**
   * Starts it: the files are with the engine and the mesh is being built.
   *
   * The cap is a backstop, not a guess at how long a model takes — it exists
   * so a browser that drops the objects event entirely cannot leave a spinner
   * on the screen for the rest of the session. Reaching it clears the row and
   * nothing else: the import is not cancelled, and if the engine is simply
   * slow the objects still land when they land.
   */
  const beginImportWait = useCallback((baselineObjects: number, label: string) => {
    if (importWaitTimerRef.current !== null) window.clearTimeout(importWaitTimerRef.current);
    importWaitRef.current = { baselineObjects };
    setImportProgress({ label, ratio: 0, extracted: 0, indeterminate: true });
    importWaitTimerRef.current = window.setTimeout(() => {
      importWaitTimerRef.current = null;
      importWaitRef.current = null;
      setImportProgress(null);
    }, IMPORT_WAIT_CEILING_MS);
  }, []);

  const importSelectedFiles = useCallback(async (rawFiles: File[]) => {
    if (!rawFiles.length || orchestrator.busy) return;
    setError("");
    setNotice("");
    /**
     * REFUSED AT SELECTION, NOT AFTER THE WAIT.
     *
     * A browser cannot slice a 1 GB model — see MODEL_FILE_BYTES_CEILING in
     * import-orchestrator.ts for the measurement and the wasm32 ceiling behind
     * it. The choice made here is WHERE the customer learns that: before a
     * byte is read, or after uploading two gigabytes and watching a progress
     * bar. This is the first, and it names the file and both numbers so the
     * answer is actionable rather than a wall.
     *
     * The whole selection is refused rather than the oversized member dropped
     * silently: a ZIP of parts plus one enormous STL is one intent, and
     * importing "most of it" without saying so is the quiet data loss this
     * codebase keeps refusing to commit.
     */
    const tooLarge = oversizedModelFiles(rawFiles);
    if (tooLarge.length) {
      setError(
        tooLarge
          .map((file) => templateText(t.fileTooLarge, {
            name: file.name,
            size: Math.ceil(file.size / MB),
            limit: Math.round(MODEL_FILE_BYTES_CEILING / MB),
          }))
          .join(" ")
      );
      setStatus("error");
      return;
    }
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
          // A null from the orchestrator means ITS work is done — extraction,
          // or the arrangement of an archive. It does not mean the engine has
          // finished reading the mesh, so while the post-dispatch wait is
          // running the row it owns stays exactly as it is.
          if (!progress) { if (!importWaitRef.current) setImportProgress(null); return; }
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
      // The engine has the files and is building the mesh. Nothing reports on
      // that stretch, so the row stays up — indeterminate — until the objects
      // arrive. For an archive the orchestrator's own arranging progress
      // replaces this a moment later and clears it the same way.
      beginImportWait(objects.length, textRef.current.importBuilding);
    } catch (reason: unknown) {
      // Nothing was restored, so nothing is coming to absorb the latch.
      restoreInFlightRef.current = false;
      endImportWait();
      setImportProgress(null);
      setError(localizeImportError(reason));
      setStatus("error");
    }
  }, [beginImportWait, endImportWait, localizeImportError, localizeImportNotice, objects, orchestrator, profile.bedDepth, profile.bedWidth, selectedPlate, t.fileTooLarge, t.importing, t.zipAnalyzing, t.zipBudgetConfirm]);

  const handlePickedFiles = useCallback((files: File[]) => {
    setNotice("");
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
  const orientAll = useCallback(async (ids?: ReadonlySet<number>) => {
    if (!objects.length) { setNotice(t.orientUnavailable); return; }
    setOrienting(true);
    setNotice(t.orientBusy);
    const api = adapter.api();
    api?.suspendRendering(true);
    // One frame, so the busy notice actually paints before the blocking pass.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let result;
    try {
      result = autoOrientObjects(adapter, { selectedPlate, ids });
    } finally {
      api?.suspendRendering(false);
      setOrienting(false);
    }
    if (!result.ok) { setNotice(t.orientUnavailable); return; }
    // What auto-orient wrote is what «تلقائي» means for these objects from
    // now on — until a later rotation moves them off it.
    setAutoRotations((current) => {
      const next = new Map(current);
      for (const entry of result.rotations ?? []) next.set(entry.id, entry.rot);
      return next;
    });
    setSceneTick((tick) => tick + 1);
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

  /**
   * The same guard the effect above applies, readable from a listener that is
   * registered once. A subscription that re-ran on every render would
   * unsubscribe and resubscribe on every frame of a drag, which is the one
   * moment it must not.
   */
  const canAutosaveRef = useRef(false);
  const autosaveAllowed =
    objects.length > 0 && !orchestrator.busy && status !== "slicing";
  useEffect(() => {
    canAutosaveRef.current = autosaveAllowed;
  }, [autosaveAllowed]);

  /**
   * MOVING A MODEL IS AN EDIT, AND AUTOSAVE COULD NOT SEE IT.
   *
   * The effect above is the only thing that marked the session dirty, and it
   * watches `objects`, the settings, the preset and the project name. A
   * transform is in none of them: the engine does not re-emit its objects
   * event when a model is dragged, rotated or scaled, so an hour spent
   * arranging forty parts on the plate scheduled exactly zero saves. Nothing
   * was written until the author happened to add or delete a part — and on an
   * iPad, «the tab came back empty» is what that looks like from the outside.
   *
   * `onSceneEdit` is the adapter's own signal for precisely this, and it
   * already exists: `use-slicing-state` subscribes to it to know a slice
   * result has gone stale. The same gesture that invalidates a slice is the
   * gesture that changes what a save would write, so autosave listens to it
   * too rather than to a second, parallel notion of "edited".
   *
   * Cost is not a worry at this layer even though a drag fires continuously.
   * `notifySceneEdited` already coalesces to one notification per microtask;
   * `markDirty` only re-arms a timer (nine seconds on a constrained device);
   * and when that timer finally fires, `contentSignature` — which reads the
   * adapter's transform fingerprint — skips the whole capture if the scene
   * ended up where it started. A drag that goes out and back costs nothing.
   */
  useEffect(() => {
    return adapter.onSceneEdit(() => {
      // `projectFilesRef` is a ref the import path writes, so it is read at
      // notification time rather than mirrored: a scene edit cannot arrive
      // before the files that produced it.
      if (!canAutosaveRef.current || !projectFilesRef.current.length) return;
      markDirty();
    });
  }, [adapter, markDirty]);

  /**
   * THE LAST MOMENT WE ARE STILL RUNNING.
   *
   * `whenIdle()` in project-sync.ts is documented as the flush "before
   * navigation/unload", and nothing in the shell ever called it. On an iPad
   * that omission is the whole bug: Safari discards a backgrounded tab
   * whenever it wants, and on the way back the page is a fresh load. With a
   * nine-second debounce on a constrained device, everything edited in the
   * last nine seconds — and, before the subscription above, everything ever
   * arranged — was simply gone.
   *
   * `visibilitychange → hidden` and `pagehide` are the two events iOS
   * actually delivers; `beforeunload` is not reliable there and is
   * deliberately not used. Both fire for an ordinary tab switch, so the save
   * is gated on `dirty`: a clean session must not pay for a full 3MF export
   * every time the owner glances at another tab.
   *
   * IT RUNS BEFORE THE WORKER IS RELEASED, and the ordering is not luck. The
   * constrained-device effect further down this file hands the WASM heap back
   * on the same `hidden` event; effects register their listeners in
   * declaration order and the DOM calls them in that order, so this one is
   * registered first and runs first. It must stay above that effect.
   *
   * Best-effort by nature: the OS may not give us the milliseconds, and
   * nothing here pretends otherwise — it is not awaited and it blocks
   * nothing. What it buys is the local draft, which is the cheap half and the
   * half that matters.
   */
  const { saveNow } = persistence;
  const syncDirtyRef = useRef(false);
  const syncDirty = persistence.state.dirty;
  useEffect(() => {
    syncDirtyRef.current = syncDirty;
  }, [syncDirty]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const flush = () => {
      if (!syncDirtyRef.current) return;
      void saveNow().catch(() => {
        // A failed flush is already reflected in the sync status; there is no
        // screen left to show anything on.
      });
    };
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [saveNow]);

  const openProjects = useCallback(async () => {
    setSheet("projects");
  }, []);

  const restoreProjectRecord = useCallback(async (saved: StoredLevoProject, options?: { relink?: boolean }) => {
    const restoredProfile = isProfileId(saved.profileId) ? saved.profileId : DEFAULT_PROFILE_ID;
    const restoredQuality = saved.quality in QUALITY ? saved.quality as QualityId : "standard";
    const restoredStrength = saved.strength in STRENGTH ? saved.strength as StrengthId : "standard";
    const restoredSupport = Boolean(saved.support);
    // Drafts and manifests written before the infill control existed carry no
    // pattern at all; they get the default rather than a guess.
    const restoredInfill = typeof saved.infill === "string" && isInfillId(saved.infill) ? saved.infill : DEFAULT_INFILL_ID;
    // Projects saved before the material row carry none, and they were PLA.
    const restoredMaterial = isMaterialId(saved.material) ? availableMaterial(restoredProfile, saved.material) : DEFAULT_MATERIAL_ID;
    const restoredKey = `${restoredProfile}:${restoredQuality}:${restoredStrength}:${restoredSupport}:${restoredInfill}:${restoredMaterial}`;
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
    // Through chooseProfile, not setProfileId: opening a project IS naming a
    // printer, so the first-run question is answered by it and must not come
    // back on the next visit.
    chooseProfile(restoredProfile);
    setQuality(restoredQuality);
    setStrength(restoredStrength);
    setSupport(restoredSupport);
    setInfill(restoredInfill);
    setMaterial(restoredMaterial);
    if (saved.settings) setSettings(saved.settings);
    /*
     * THE SAME SELECTION REOPENS WITHOUT A PRESET LOAD, SO ITS SETS ARE SEEDED
     * HERE. With the selection of the draft equal to the one in force (the
     * usual case) the preset effect does not run again, and setSettings bypasses
     * recordEngineWrites: the layer height, infill and walls of the draft were
     * in neither set, and the next Support flip rebuilt them from the preset
     * (0.12 mm came back as 0.2, with nothing said). Seeded the way the
     * effect seeds a restored project: nothing counts as typed, and what the
     * draft holds beyond the loaded preset is carried silently.
     */
    if (saved.settings && !restoredSettingsRef.current) {
      userEditedKeysRef.current = new Set();
      engineKeysRef.current = new Set(keysAwayFromPreset(loadedPresetRef.current ?? saved.settings, saved.settings));
    }
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
  }, [adapter, chooseProfile, orchestrator, requestedPresetKey, t.engineUnavailable, t.savedLocalFull, t.savedLocalSourceOnly]);

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
    await restoreProjectRecord(recordFromOpened(opened, opened.project.id, opened.project.name), { relink: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence.openAccountProject, restoreProjectRecord, t.actionUnavailable]);

  /**
   * History → "open as a copy" (P1-09). The kept revision opens as a NEW
   * local project (fresh id, no account link): editing it can never become
   * the account project's next head by accident — "make this the current
   * version" is the explicit, server-side way to do that.
   */
  const openRevisionCopyInEditor = useCallback(async (summary: RemoteProjectSummary, revision: RemoteRevision) => {
    let opened: OpenedRemoteProject;
    try {
      opened = await persistence.openAccountRevision(summary.id, revision.id);
    } catch {
      setNotice(t.actionUnavailable);
      return;
    }
    const name = `${summary.name} · ${revision.revision}`.slice(0, 80);
    await restoreProjectRecord(recordFromOpened(opened, crypto.randomUUID(), name));
    setNotice(templateText(t.revisionCopyOpened, { n: revision.revision }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence.openAccountRevision, restoreProjectRecord, t.actionUnavailable, t.revisionCopyOpened]);

  /**
   * History → "make this the current version" made a NEW head on the server.
   * If that project is the one open here AND everything in the editor is
   * already saved, reload it so the editor shows the restored version. With
   * unsaved edits it is NOT reloaded — that would throw the edits away
   * silently; the next save meets the moved head as an ordinary conflict and
   * the person chooses (rebase, keep the server version, or fork).
   */
  const reloadAfterRevisionRestore = useCallback(async (summary: RemoteProjectSummary) => {
    const sync = persistence.state;
    if (sync.remoteProjectId !== summary.id) return;
    if (sync.dirty || sync.status !== "synced") return;
    await openAccountProjectInEditor(summary);
  }, [persistence.state, openAccountProjectInEditor]);

  /**
   * Explicit sign-out (P1-09). Ticked, this account's drafts leave the device
   * first — the hook disposes the autosave controller before purging, so no
   * pending save can write one back. Either way the worker route ends the
   * session; a purge failure never blocks the sign-out itself.
   */
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useCallback(async (purgeDrafts: boolean) => {
    setSigningOut(true);
    if (purgeDrafts) {
      try {
        await persistence.purgeLocalDraftsForSignOut();
      } catch {
        /* the session still ends; the drafts stay namespaced to this account */
      }
      // The mode mirror is keyed by this account too: a shared device keeps
      // no trace of it once the person asked for their drafts to go.
      studioMode.clearLocalMirror();
    }
    window.location.assign(SIGN_OUT_HREF);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence.purgeLocalDraftsForSignOut, studioMode.clearLocalMirror]);

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
      }, {
        trustPrompt: t.certTrustPrompt,
        fileUnavailable: t.certFileUnavailable,
        trustCancelled: t.certTrustCancelled,
        addressInvalid: t.lanAddressInvalid,
        accessCodeInvalid: t.lanAccessCodeInvalid,
        serialRequired: t.lanSerialRequired,
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
  }, [lanAccessCode, lanAction, lanIp, lanSerial, nativeEnvironment.capabilities.lanConnection, t]);

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

  /** The backdrop closes the sheet on the click of a press that began on it (see the markup). */
  const pressBackdrop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    backdropPressRef.current = event.target === event.currentTarget;
  }, []);
  const closeFromBackdrop = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const pressedHere = backdropPressRef.current;
    backdropPressRef.current = false;
    if (pressedHere && event.target === event.currentTarget) setSheet(null);
  }, []);

  /**
   * THE PAGE BEHIND AN OPEN SHEET IS OUT OF REACH, AND FOCUS COMES BACK.
   *
   * `aria-modal` claimed a modal while Tab walked out of the sheet onto the
   * back link, «حفظ», «استيراد», «المزيد» and the mode switch behind it, and
   * Escape dropped focus on the body (WCAG 2.4.3). The «المزيد» sheet holds
   * about twenty-five actions, the source link among them, so it has to
   * behave like the modal it says it is. While any sheet is open every
   * sibling of the backdrop is `inert` (out of the tab order and the
   * accessibility tree), including one that renders while it is open; Tab
   * and Shift+Tab wrap inside the sheet; and when the last sheet closes,
   * by any path, focus goes back to the control that opened it. Switching
   * from one sheet to another keeps the first opener.
   */
  const sheetOpen = sheet !== null;
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!sheetOpen) return;
    const active = document.activeElement;
    sheetOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    const backdrop = sheetRef.current?.closest<HTMLElement>(".sheet-backdrop") ?? null;
    const page = backdrop?.parentElement ?? null;
    const hide = () => {
      if (!page || !backdrop?.isConnected) return;
      for (const child of page.children) {
        if (child !== backdrop) (child as HTMLElement).inert = true;
      }
    };
    hide();
    const observer = new MutationObserver(hide);
    if (page) observer.observe(page, { childList: true });
    return () => {
      observer.disconnect();
      if (page) for (const child of page.children) (child as HTMLElement).inert = false;
      const opener = sheetOpenerRef.current;
      sheetOpenerRef.current = null;
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    };
  }, [sheetOpen]);

  /**
   * Escape closes the sheet, and opening one moves focus into it.
   *
   * A dialog that declares `aria-modal` and then leaves focus on the page
   * behind is a dialog a keyboard or a screen reader never enters — the
   * skill's §10 (correct focus handling) and §12 (keyboard navigation). The
   * listener is on the document because the sheet's own contents are the
   * likeliest focus target, and a key pressed inside a field in the sheet
   * still has to reach it.
   *
   * NOTHING BEHIND THE SHEET HEARS A KEY (c6-r4-ha-02). The engine binds its
   * shortcuts on window (arrows nudge the selected model, Delete removes it,
   * m / r / s pick a gizmo) and skips only text fields, so a key pressed on a
   * button in the sheet edited the scene the sheet covers. While a sheet is
   * open, a key that did not start inside the engine's own mount stops at
   * the document, after the sheet's own handlers (React's) and this one have
   * run, and never reaches window. The page behind is inert, so no real key
   * can start inside the engine while a sheet is open; the exception is
   * only for the Studio's own synthetic shortcuts, dispatched on the engine
   * shell as the sheet closes.
   */
  useEffect(() => {
    if (!sheet) return;
    sheetRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const mount = viewportMountRef.current;
      if (!(mount && event.target instanceof Node && mount.contains(event.target))) event.stopPropagation();
      if (event.key === "Escape") { setSheet(null); return; }
      if (event.key !== "Tab") return;
      const dialog = sheetRef.current;
      if (!dialog) return;
      const tabbable = [...dialog.querySelectorAll<HTMLElement>(SHEET_TABBABLE)]
        .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      if (!tabbable.length) return;
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === dialog || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
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
    // While a slice runs, this button is CANCEL — and cancelling has to go
    // through the adapter, not straight at the engine's own button. The
    // engine's cancel writes into a SharedArrayBuffer it only has under
    // cross-origin isolation, which `worker/platform.ts` withholds from every
    // Apple UA, so clicking its button on an iPad did nothing at all. See
    // EngineAdapter.cancelSlice.
    if (status === "slicing") {
      if (!adapter.cancelSlice()) setNotice(t.actionUnavailable);
      return;
    }
    if (plateCount === 1) {
      if (!adapter.clickControl("slice-btn")) setNotice(t.actionUnavailable);
      return;
    }
    if (!adapter.triggerSlice(allPlates ? "all" : "current")) setNotice(t.actionUnavailable);
  }, [adapter, cancelIdleWorkerRelease, plateCount, status, t.actionUnavailable]);

  const currentResultState = slicing.resultState(selectedPlate);
  const currentStale = currentResultState === "stale";
  const printReady = status !== "slicing" && status !== "error" && currentResultState === "fresh";
  /*
   * The G-code links of the engine follow the same rule as the export of the
   * shell (app/editor-theme.ts, G-CODE ONLY FROM A FRESH RESULT): they show
   * only while this is "fresh". Opening «كل الإعدادات» on a phone puts them
   * in reach, and after an edit they still held the G-code of the old
   * settings.
   */
  useEffect(() => {
    adapter.setHostAttribute("data-levo-result", printReady ? "fresh" : "not-fresh");
  }, [adapter, printReady]);

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
  /**
   * The engine's slow-slice warning, carried by the shell (see
   * heavyImportTriangles). Like the engine, it judges the objects ONE change
   * added: a new import over the threshold raises it, any other import clears
   * it, and a split or a delete (which removes ids) leaves it as it was.
   */
  const noteHeavyImport = useCallback((nextIds: readonly number[]) => {
    const previous = triangleCheckedIdsRef.current;
    const next = new Set(nextIds);
    triangleCheckedIdsRef.current = next;
    if (!next.size) {
      setHeavyImportTriangles(null);
      return;
    }
    for (const id of previous) if (!next.has(id)) return;
    const appeared = [...next].filter((id) => !previous.has(id));
    if (!appeared.length) return;
    const triangles = adapter.triangleCountOf(appeared);
    setHeavyImportTriangles(isHeavyImport(triangles) ? triangles : null);
  }, [adapter]);

  /** The engine's own "simplified retry", from the shell's error row. */
  const simplifiedRetry = useCallback(() => {
    setDowngradeOfferFor(null);
    if (!adapter.clickControl("downgrade-retry")) return;
    setError("");
    setNotice("");
    setStatus("editing");
  }, [adapter]);

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
      // The engine has the model. This is the only honest end to the wait the
      // import row is holding — see importWaitRef above.
      if (importWaitRef.current && event.value.length > importWaitRef.current.baselineObjects) endImportWait();
      setObjects(event.value);
      // The phone shell re-reads the scene (size, orientation, file chip) and
      // the engine's active gizmo on every objects change.
      setSceneTick((tick) => tick + 1);
      setActiveGizmo((current) => adapter.activeGizmo() ?? current);
      const ids = event.value.map((object) => object.id);
      noteHeavyImport(ids);
      orchestrator.notifyObjects(ids);
      seatNewObjectsIfNeeded(ids);
      if (event.value.length) setStatus((current) => current === "slicing" ? current : "editing");
    } else if (event.type === "plateCount") {
      /*
        «عند اضافة سرير طباعة جديد يبقيني على السرير الاول بدل ان ينقلني للسرير
         الذي انشأته (كما في بامبو سلايسر).»

        The engine's add-plate handler only increments the plate count; it
        never calls its own selectPlate. So a new plate appeared in the bar and
        the camera stayed on the first one, which is not what any slicer does.

        THE FOLLOW IS DONE HERE, NOT ON THE BUTTON, because there are two ways
        to add a plate and only one of them is ours: the Studio's tool-tray
        button is mobile-only, and on desktop the engine's own `+` in the plate
        bar is the ONLY control. Reacting to the COUNT means both paths are
        covered by one rule.

        Gated on a rise of exactly one from a non-zero count. An interactive
        add is always +1; a first load or a restored draft sets the count from
        0 or jumps by several at once, and jumping the selection to the last
        plate there would fight the restore for the camera.
      */
      const before = plateCountRef.current;
      plateCountRef.current = event.value;
      setPlateCount(event.value);
      if (before > 0 && event.value === before + 1) adapter.selectPlate(event.value - 1);
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
    } else if (event.type === "slicing") {
      setStatus(event.value ? "slicing" : "editing");
    } else if (event.type === "notice") {
      if (suppressNextExportNoticeRef.current && /^Saved .*3mf project/i.test(event.value)) {
        suppressNextExportNoticeRef.current = false;
        return;
      }
      // The engine speaks English; the row speaks the person's language, and
      // a sentence the map does not know reads as a generic line in Arabic
      // and Sorani, never as raw English (app/engine-messages.ts).
      setNotice(localizeEngineMessage(event.value, "notice", textRef.current, localeRef.current));
    } else if (event.type === "error") {
      // An EMPTY value is the engine clearing its own error, which it does in
      // the same commit that starts a slice (its simplified retry included),
      // and its error event arrives after the slicing one. So it clears the
      // message and the retry offer and leaves a live status alone: setting
      // "error" here hid the progress and Cancel N% of exactly the slow,
      // memory-heavy slice the retry is for.
      if (!event.value) {
        setError("");
        setDowngradeOfferFor(null);
        setStatus((current) => current === "error" ? "editing" : current);
        return;
      }
      // An engine error is the other honest end to the wait: no objects are
      // coming, so the row must not sit there until its ceiling runs out.
      endImportWait();
      const message = localizeEngineMessage(event.value, "error", textRef.current, localeRef.current);
      setError(message);
      // The engine renders its retry offer in the same commit as this error,
      // so its button is already in the (possibly hidden) side panel here.
      setDowngradeOfferFor(adapter.isControlAvailable("downgrade-retry") ? message : null);
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, endImportWait, noteHeavyImport, orchestrator, seatNewObjectsIfNeeded, slicing.handleViewportEvent]);

  const handleSliced = useCallback((payload: SlicePayload) => {
    const outcome = slicing.handleSliced(payload);
    // The slow-slice warning has done its job once a slice of the scene
    // finishes; left up, it outlived the result and hid other messages.
    setHeavyImportTriangles(null);
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
    // A new project starts from the preset, not from the last project's edits
    // or the values its file brought.
    userEditedKeysRef.current = new Set();
    engineKeysRef.current = new Set();
    arrangeUndoRef.current = null;
    orientUndoRef.current = null;
    setOrientUndoAvailable(false);
    cutUndoRef.current = null;
    setCutUndoAvailable(false);
    setArrangeUndoAvailable(false);
    setAutoRotations(new Map());
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
    endImportWait();
    setImportProgress(null);
    setSidebarOpen(false);
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
  }, [endImportWait, objects.length, orchestrator, slicing.clearResults, t.newConfirm]);

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
  /**
   * `↻ 2/3` beside the percentage while the engine is on a RETRY.
   *
   * It is a glyph and two numbers on purpose, with no dictionary entry: the
   * slicing status is already a bare percentage in all three languages, and
   * `↻ 2/3` reads the same in Arabic, English and Sorani without a translation
   * anyone would have to review. It appears only when a retry actually
   * started, so an unpatched engine — and every slice that succeeds first
   * time — shows exactly the label it showed before.
   */
  const retrySuffix = slicing.retryAttempt > 1
    ? ` ↻ ${slicing.retryAttempt}/${slicing.retryTotal}`
    : "";
  const statusLabel = status === "slicing"
    ? `${Math.round(slicing.progress * 100)}%${retrySuffix}`
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

  const sheetTitle = sheet === "printer" ? t.choosePrinter
    : sheet === "about" ? t.about
    : sheet === "projects" ? t.projects
      : sheet === "print" ? t.printExport
        : sheet === "connect" ? t.connectTitle
          : sheet === "cut" ? t.cutTitle
            : sheet === "signout" ? t.signOut
              : sheet === "more" ? t.moreTitle
                : t.settings;

  const savedStateLabel = displaySavedKind === "full"
    ? t.savedLocalFull
    : displaySavedKind === "source-only"
      ? t.savedLocalSourceOnly
      : t.autosaved;

  // -- the phone shell (plan item C6) ----------------------------------------
  /**
   * The scene emits no event when a model is moved, turned or selected, so
   * the size readout, the orientation chips and the file chip re-read it after
   * the engine's own gesture signal (onSceneEdit: pointer up, key up), once
   * the gesture has settled. Cheap: the size cache skips any object whose
   * rotation and scale did not change.
   */
  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = adapter.onSceneEdit(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setSceneTick((tick) => tick + 1);
        setActiveGizmo((current) => adapter.activeGizmo() ?? current);
      }, 180);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [adapter]);

  /** The phone column (.studio-scroll): the card and everything beside it. */
  const scrollColumnRef = useRef<HTMLDivElement>(null);

  /**
   * Escape gives the page back from the expanded viewport (no sheet open),
   * and puts focus back on the expand button, the control that opened it,
   * instead of leaving it on something that is about to move.
   */
  useEffect(() => {
    if (!viewportExpanded || sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setViewportExpanded(false);
      setSidebarOpen(false);
      window.requestAnimationFrame(() => {
        scrollColumnRef.current?.querySelector<HTMLElement>('[data-levo-action="viewport-expand"]')?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet, viewportExpanded]);

  /**
   * THE PAGE UNDER THE EXPANDED VIEWPORT IS OUT OF REACH, FOR THE KEYBOARD TOO.
   *
   * Expanded, the card covers the whole screen, but the column behind it
   * kept its controls in the tab order: Tab walked onto the printer, the
   * material, the infill and supports selects and the orientation chips, a
   * focus ring nobody could see on settings that still changed (WCAG 2.4.7,
   * 2.4.11). So every sibling of the card in the column is `inert` while it
   * is expanded (out of the tab order, out of the accessibility tree, as it
   * is out of sight), including a sibling that renders while expanded, and
   * nothing is left inert after it collapses. If the focused control is one
   * of those (the «كل الإعدادات» row expands the card), focus moves to the
   * collapse button rather than being dropped on the body. Crossing to the
   * desktop layout, where nothing covers the column, collapses the card.
   */
  useEffect(() => {
    const column = scrollColumnRef.current;
    if (!column || !viewportExpanded) return;
    const card = column.querySelector<HTMLElement>(":scope > .editor-area");
    const hide = () => {
      for (const child of column.children) {
        if (child !== card) (child as HTMLElement).inert = true;
      }
    };
    hide();
    const active = document.activeElement;
    if (card && active && column.contains(active) && !card.contains(active)) {
      card.querySelector<HTMLElement>('[data-levo-action="viewport-expand"]')?.focus({ preventScroll: true });
    }
    const observer = new MutationObserver(hide);
    observer.observe(column, { childList: true });
    const phone = window.matchMedia?.("(max-width: 899px)");
    const onLayout = () => { if (!phone?.matches) setViewportExpanded(false); };
    phone?.addEventListener?.("change", onLayout);
    return () => {
      observer.disconnect();
      phone?.removeEventListener?.("change", onLayout);
      for (const child of column.children) (child as HTMLElement).inert = false;
    };
  }, [viewportExpanded]);

  const toggleViewportExpanded = useCallback(() => {
    setViewportExpanded((value) => {
      // Closing the full view closes the engine panel that needed it.
      if (value) setSidebarOpen(false);
      return !value;
    });
  }, []);

  /**
   * Whether the engine has an object selected, read when the «المزيد» sheet
   * renders: duplicate, split and delete act on the selection only, so their
   * tiles wait for one (the only model on the bed is not selected by itself).
   */
  const engineHasSelection = () => {
    try {
      return Boolean(adapter.api()?.selectedObjectId());
    } catch {
      return false;
    }
  };

  /**
   * What the scene is, read for the phone shell: each object's measured size,
   * the selected one (or the only one), the orientation preset the targets
   * are in, and the name for the file chip. Re-read when `objects` changes
   * and on every settled gesture (`sceneTick`).
   */
  const sceneFacts = useMemo(() => {
    void sceneTick;
    const snapshots = objects.length ? adapter.sceneSnapshot() : [];
    dimensionCache.retain(snapshots.map((snapshot) => snapshot.id));
    const measured = snapshots.map((snapshot) => ({ snapshot, dims: dimensionCache.measure(snapshot), extent: dimensionCache.extent(snapshot) }));
    let selectedId: number | null = null;
    try {
      selectedId = adapter.api()?.selectedObjectId() || null;
    } catch {
      selectedId = null;
    }
    const selected = measured.find((entry) => entry.snapshot.id === selectedId) ?? (measured.length === 1 ? measured[0] : null);
    const targets = selected ? [selected.snapshot] : measured.map((entry) => entry.snapshot);
    const name = selected ? (objects.find((object) => object.id === selected.snapshot.id)?.name ?? selected.snapshot.name) : null;
    return {
      measured,
      selectedId: selected?.snapshot.id ?? null,
      dimensions: selected?.dims ? formatDimensions(selected.dims) : null,
      needsSelection: !selected && measured.length > 1,
      orientation: currentPreset(targets, autoRotations),
      fileLabel: name || (measured.length > 1 ? `${projectName.trim() || "LEVO Project"} · ${measured.length}` : null),
    };
  }, [adapter, autoRotations, dimensionCache, objects, projectName, sceneTick]);

  /**
   * THE PREFLIGHT, MOUNTED AT LAST. makerworld/preflight.ts was written for
   * the MakerWorld step and never shown; it now decides whether the banner
   * may say «جاهز للتقطيع»: a model larger than the printer in every
   * in-plane orientation is a blocker, measured from the same sizes the
   * readout shows.
   */
  const preflight = useMemo(() => {
    const sizes = new Map(sceneFacts.measured.map((entry) => [entry.snapshot.id, entry.dims]));
    return runPreflight({
      objects: objects.map((object) => {
        const dims = sizes.get(object.id);
        return {
          id: object.id,
          name: object.name,
          extruder: object.extruder,
          visible: object.visible,
          widthMm: dims?.width,
          depthMm: dims?.depth,
          heightMm: dims?.height,
        };
      }),
      plateCount,
      profile: {
        id: profile.id,
        model: profile.model,
        shortName: profile.shortName,
        nozzle: profile.nozzle,
        bedWidthMm: profile.bedWidth,
        bedDepthMm: profile.bedDepth,
        bedHeightMm: profile.bedHeight,
      },
      profileVerified: profileLoadState?.verified ?? true,
      missingPresets: profileLoadState?.missingPresets.map((preset) => preset.presetName) ?? [],
    });
  }, [objects, plateCount, profile, profileLoadState, sceneFacts]);

  /**
   * WHERE THE MODELS ARE, NOT ONLY HOW BIG. The preflight above measures
   * size; a model dragged off the bed passes it and the engine then refuses
   * the slice. Each visible object is placed on the plate it is nearest to
   * and its footprint compared with that bed (model-dimensions objectsOffBed),
   * so the banner says «خارج حدود سطح الطباعة» before the slice, not after.
   */
  const offBedCount = useMemo(() => {
    const api = adapter.api();
    if (!api || !sceneFacts.measured.length) return 0;
    const placed = sceneFacts.measured
      .filter((entry) => entry.snapshot.visible !== false)
      .map((entry) => {
        let plateCentre = { x: 0, z: 0 };
        try {
          plateCentre = api.platePos(adapter.plateOfSnapshot(entry.snapshot, plateCount));
        } catch {
          // An engine without plate offsets has one plate, at the origin.
        }
        return { id: entry.snapshot.id, pos: entry.snapshot.pos, extent: entry.extent, plateCentre };
      });
    return objectsOffBed(placed, { width: profile.bedWidth, depth: profile.bedDepth }).length;
  }, [adapter, plateCount, profile.bedDepth, profile.bedWidth, sceneFacts]);

  /**
   * THE PLATE THE SLICE ACTS ON, NOT THE WHOLE SCENE. `objects` counts every
   * plate, while the slice, its result and the G-code are the current
   * plate's. After «+ Plate» the new, empty plate is the current one, and the
   * banner said «جاهز للتقطيع» over it until the engine refused the slice
   * («Plate 2 has no objects»). So the visible models are counted on the
   * selected plate, by the nearest-plate rule (adapter plateOfSnapshot) the
   * placement check above uses.
   * Undefined while the scene cannot be read, so nothing is judged empty
   * from a missing snapshot.
   */
  const plateObjectCount = useMemo(() => {
    if (!sceneFacts.measured.length) return undefined;
    return sceneFacts.measured.filter((entry) => (
      entry.snapshot.visible !== false && adapter.plateOfSnapshot(entry.snapshot, plateCount) === selectedPlate
    )).length;
  }, [adapter, plateCount, sceneFacts, selectedPlate]);

  /**
   * The orientation chips. «تلقائي» is the existing auto-orient; the other two
   * are fixed rotations (engine-adapter applyOrientationPreset). Each one
   * applies to the selected object, or to every object when none is selected,
   * and each is undone from the message row like the other whole-scene edits.
   */
  const orientTo = useCallback(async (preset: OrientationPreset) => {
    if (!objects.length) { setNotice(t.orientUnavailable); return; }
    const ids = sceneFacts.selectedId !== null ? new Set([sceneFacts.selectedId]) : undefined;
    if (preset === "auto") { await orientAll(ids); return; }
    const result = applyOrientationPreset(adapter, { preset, ids, selectedPlate });
    if (!result.ok) { setNotice(t.orientUnavailable); return; }
    setAutoRotations((current) => {
      const next = new Map(current);
      for (const entry of sceneFacts.measured) {
        if (!ids || ids.has(entry.snapshot.id)) next.delete(entry.snapshot.id);
      }
      return next;
    });
    orientUndoRef.current = result.undo;
    raiseUndo("orient", Boolean(result.undo));
    setNotice(result.changedCount ? templateText(t.orientPresetDone, { count: result.changedCount }) : t.orientNoChange);
    setSceneTick((tick) => tick + 1);
  }, [adapter, objects.length, orientAll, raiseUndo, sceneFacts, selectedPlate, t.orientNoChange, t.orientPresetDone, t.orientUnavailable]);

  /**
   * «كل الإعدادات»: the engine's full side panel. In Simple it does not exist,
   * so asking for it is asking for Advanced. On a phone the panel needs the
   * whole screen, so the viewport expands under it.
   */
  const openAllSettings = useCallback(() => {
    setSheet(null);
    if (simpleMode) studioMode.setMode("advanced");
    setSidebarOpen(true);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 899px)").matches) setViewportExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simpleMode, studioMode.setMode]);

  /**
   * «حفظ»: save now, and say where it went. A signed-in session that is not
   * linked to an account project yet gets one first (named after the
   * project); a guest gets a draft on this device and the sign-in hint. The
   * answer is read from the sync state AFTER the save settles, so a failed
   * upload is never reported as saved.
   */
  const syncStateRef = useRef(persistence.state);
  useEffect(() => { syncStateRef.current = persistence.state; }, [persistence.state]);
  const saveProjectNow = useCallback(async () => {
    if (!objects.length || saving) return;
    setSaving(true);
    try {
      if (user?.id && !syncStateRef.current.remoteProjectId) {
        await persistence.createRemoteProjectAndLink(projectName.trim() || "LEVO Project");
      }
      await saveNow();
      await nextFrame();
      const sync = syncStateRef.current;
      if (sync.status === "failed" || sync.conflict) setNotice(t.saveFailed);
      else setNotice(user?.id && sync.status === "synced" ? t.savedToAccount : t.savedDraftGuest);
    } catch {
      setNotice(t.saveFailed);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects.length, persistence.createRemoteProjectAndLink, projectName, saveNow, saving, t.saveFailed, t.savedDraftGuest, t.savedToAccount, user?.id]);

  /**
   * The back chevron leaves the editor. A guest's work is already a draft on
   * this device (and pagehide flushes the last edits), so only two things are
   * worth a question: a slice in progress, and a signed-in session with
   * changes the account does not have yet.
   */
  const confirmLeave = useCallback(() => {
    const sync = syncStateRef.current;
    const unsavedAccountWork = Boolean(user?.id) && objects.length > 0 && (sync.dirty || sync.status === "failed" || sync.status === "uploading");
    if (status !== "slicing" && !unsavedAccountWork) return true;
    return window.confirm(t.leaveConfirm);
  }, [objects.length, status, t.leaveConfirm, user?.id]);

  /** The overflow sheet's actions: the sheet closes first, then the action runs. */
  const runOverflow = useCallback((action: OverflowAction) => {
    setSheet(null);
    if (action === "projects") void openProjects();
    else if (action === "new-project") newProject();
    else if (action === "duplicate") runTool("tool-duplicate");
    else if (action === "delete") runTool("tool-delete");
    else if (action === "split") runTool("tool-split");
    else if (action === "on-bed") runTool("tool-onbed");
    else if (action === "paint") runTool("gizmo-paint");
    else if (action === "cut") openCut();
    else if (action === "auto-orient") void orientAll();
    else if (action === "delete-all") deleteAll();
    else if (action === "add-plate") clickControl("plate-add");
    else if (action === "slice-all") triggerSlice(true);
    else if (action === "toggle-preview") clickControl(canvasMode === "preview" ? "mode-prepare" : "mode-preview");
    else if (action === "zoom-all") shortcut("z");
    else if (action === "zoom-bed") shortcut("b");
    else if (action === "undo") clickControl("undo");
    else if (action === "redo") clickControl("redo");
    else if (action === "makerworld") prepareForBambuHandy();
    else if (action === "share-gcode") void shareCurrentGcode();
    else if (action === "export-all") clickControl("export-all");
    else if (action === "print-sheet") openPrintCenter();
    else if (action === "settings") setSheet("setup");
    else if (action === "all-settings") openAllSettings();
    else if (action === "sign-out") setSheet("signout");
    else if (action === "connect") setSheet("connect");
    else if (action === "about") setSheet("about");
  }, [canvasMode, clickControl, deleteAll, newProject, openAllSettings, openCut, openPrintCenter, openProjects, orientAll, prepareForBambuHandy, runTool, shareCurrentGcode, shortcut, triggerSlice]);

  /** The filament the kernel will use for T1, for the «الخامة» row and the sheet header. */
  // The selector stands in for T1 only until the first preset load has
  // finished; after it, the map is what the kernel slices (c6-r4-ha-01).
  // A listed name counts only at that preset's temperatures (c6fix-r1-ha-02).
  const presetLoaded = loadedPresetKey !== "";
  const t1Material = useMemo(
    () => materialInForce(profile, settings, material, presetLoaded, listedFilaments),
    [listedFilaments, material, presetLoaded, profile, settings],
  );
  const chooseMaterial = useCallback((id: MaterialId) => {
    if (id !== material) {
      setMaterial(id);
      return;
    }
    // The row showed the filament on T1, not the selector, and the person
    // picked the material the selector already holds: take T1 back to it.
    materialTakeBackRef.current = true;
    setMaterialTakeBack((value) => value + 1);
  }, [material]);

  /** The infill density the kernel will use, for the «الملء» row. */
  const effectiveInfill = useMemo(() => {
    const value = Number.parseFloat(String((settings as unknown as Record<string, unknown>).sparse_infill_density));
    return Number.isFinite(value) && value >= 0 ? value : STRENGTH[strength].infill;
  }, [settings, strength]);

  /*
    ONE MESSAGE SLOT, IN THIS ORDER: an error; the slow-slice warning when the
    only notice is the generic «files were added» (it says more about the same
    import, and the notice arrives first, so it used to hide the warning until
    the person closed it — usually after slicing); any other notice; then the
    outdated-result banner, which always shows when nothing above is up and
    carries the slow-slice warning in its own text rather than being hidden by
    it. A completed slice clears the warning (handleSliced).
  */
  const heavyImportText = heavyImportTriangles === null ? ""
    : templateText(t.heavyModelWarning, { count: Math.round(heavyImportTriangles).toLocaleString(dateLocaleFor(locale)) });
  const noticeIsOnlyImported = notice !== "" && notice.split(t.imported).every((part) => part.trim() === "");
  const messageText = error || (heavyImportText && noticeIsOnlyImported ? "" : notice);
  const staleBannerShown = currentStale && !messageText && status !== "slicing";
  const heavyWarningShown = Boolean(heavyImportText) && !messageText && !staleBannerShown;

  /*
    THE READINESS BANNER (phone): its kind comes from components/mobile/
    readiness.ts, which never returns a success over a blocker, an outdated
    result or a missing preset; its second line carries the real numbers.
  */
  const readiness = readinessOf({
    objectCount: objects.length,
    importing: Boolean(importProgress),
    engineReady: Boolean(Viewport),
    profileLoading,
    profileVerified: profileLoadState?.verified ?? true,
    slicing: status === "slicing",
    errored: status === "error",
    resultState: currentResultState,
    preflightOk: preflight.ok,
    offBedCount,
    plateObjectCount,
  });
  const oversizedCount = preflight.findings.find((finding) => finding.code === "object-exceeds-bed")?.objectIds?.length ?? 0;
  const sliceStats = printReady ? slicing.stats(selectedPlate) : null;
  const estimateSeconds = Number(sliceStats?.time_estimate);
  // The engine's own stats card counts the layers it printed; the banner says
  // the same number rather than the preview's layer count beside it.
  const slicedLayers = Number(sliceStats?.layers) > 0 ? Number(sliceStats?.layers) : slicing.layerCount;
  const readinessDetail = readiness === "empty"
    ? templateText(t.emptyPlateHelp, { plate: selectedPlate + 1 })
    : readiness === "blocked"
      ? (oversizedCount
        ? templateText(t.tooBigHelp, { count: oversizedCount, printer: profile.model, bed: `${profile.bedWidth} × ${profile.bedDepth} × ${profile.bedHeight}` })
        : offBedCount
          ? templateText(t.offBedHelp, { count: offBedCount, printer: profile.model })
          : templateText(t.overBedError, { printer: profile.shortName }))
      : readiness === "stale"
        ? (heavyImportText ? `${t.staleHelp} ${heavyImportText}` : t.staleHelp)
        : readiness === "fallback"
          ? templateText(t.presetFallbackWarning, { presets: profileLoadState?.missingPresets.map((preset) => preset.presetName).join(" · ") || "—" })
          : readiness === "sliced"
            ? (Number.isFinite(estimateSeconds) && estimateSeconds > 0
              ? templateText(t.slicedEstimate, { layers: slicedLayers || "—", time: formatDuration(estimateSeconds, t, locale) }, locale)
              : templateText(t.slicedSummary, { layers: slicedLayers || "—" }, locale))
            : t.readyToSliceHelp;

  return (
    <main className="studio-app" data-viewport={viewportExpanded ? "expanded" : "card"}>
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
        simpleMode={simpleMode}
        sliceAction={{
          label: status === "slicing" ? `${t.cancel} ${Math.round(slicing.progress * 100)}%` : t.slice,
          busy: status === "slicing",
          disabled: !objects.length,
          onClick: primaryAction,
        }}
        onPickFiles={handlePickedFiles}
        onNewProject={newProject}
        onOpenProjects={() => void openProjects()}
        onOpenPrintCenter={openPrintCenter}
        onOpenSetup={() => setSheet("setup")}
        onOpenConnect={() => setSheet("connect")}
        onOpenAbout={() => setSheet("about")}
        onRequestSignOut={user?.id ? () => setSheet("signout") : undefined}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
      />

      {/*
        ONE TREE FOR BOTH LAYOUTS (globals.css, THE PHONE SHELL). On a desktop
        `.studio-scroll` is the workspace under the header and every `.m-only`
        piece is hidden; below 900px the header is hidden and this becomes the
        reference column. The engine mount sits in the same place in both, so
        a tablet turning across 900px keeps its scene.
      */}
      <div className="studio-scroll" ref={scrollColumnRef}>
        <StudioTopBar
          t={t}
          importDisabled={!Viewport || Boolean(importProgress)}
          onPickFiles={handlePickedFiles}
          saveDisabled={!objects.length}
          saving={saving}
          onSave={() => void saveProjectNow()}
          onLeave={confirmLeave}
        />

        <div className="m-moderow m-only">
          <button className="m-btn m-more" type="button" onClick={() => setSheet("more")} aria-haspopup="dialog" data-levo-action="more">
            <Icon name="more" /><span>{t.more}</span>
          </button>
          <ModeSegmented t={t} mode={studioMode.mode} onMode={studioMode.setMode} />
        </div>

        <div className="studio-messages">
          {messageText && <div className={`editor-message ${error ? "error" : "notice"}`} role={error ? "alert" : "status"}>
            <span>{messageText}</span>
            {error && downgradeOfferFor === error && <button className="message-action" data-levo-action="simplified-retry" title={t.simplifiedRetryHelp} onClick={simplifiedRetry}>{t.simplifiedRetry}</button>}
            {!error && arrangeUndoAvailable && <button className="message-action" onClick={undoArrange}>{t.arrangeUndo}</button>}
            {!error && orientUndoAvailable && <button className="message-action" onClick={undoOrient}>{t.orientUndo}</button>}
            {!error && cutUndoAvailable && <button className="message-action" onClick={undoCut}>{t.cutUndo}</button>}
            <button onClick={() => { setError(""); setNotice(""); setDowngradeOfferFor(null); if (status === "error") setStatus("editing"); }} aria-label={t.close}><Icon name="close" /></button>
          </div>}
          {heavyWarningShown && <div className="editor-message notice" role="status" data-levo-warning="heavy-import">
            <span>{heavyImportText}</span>
            <button onClick={() => { setHeavyImportTriangles(null); if (noticeIsOnlyImported) setNotice(""); }} aria-label={t.close}><Icon name="close" /></button>
          </div>}
          {staleBannerShown && <div className="stale-banner" role="status">
            <Icon name="warning" /><span>{heavyImportText ? `${t.staleHelp} ${heavyImportText}` : t.staleHelp}</span>
            <button onClick={() => triggerSlice(false)}>{t.slice}</button>
          </div>}
        </div>

        <ViewportCard
          t={t}
          busy={Boolean(importProgress)}
          onDragOverCapture={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDropCapture={handleDropFiles}
          overlay={Viewport ? {
            fileLabel: sceneFacts.fileLabel,
            expanded: viewportExpanded,
            hasObjects: objects.length > 0,
            onToggleExpanded: toggleViewportExpanded,
            onResetView: () => { if (!adapter.frame()) shortcut("z"); },
            onViewBed: () => shortcut("b"),
          } : null}
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
            {/*
              «وتحميل من ١ ل١٠٠ اثناء تحميل الملف للبرنامج» — the bar alone
              answers "is it moving", not "how far". On a 400 MB file those are
              different questions, and the second is the one somebody watching a
              phone for thirty seconds is actually asking.

              Floored, never rounded: 99.7% must not read «100» while the file is
              still being parsed, and clamped at 99 for the same reason — the
              hundred belongs to the finished import, which is the moment this
              whole row disappears. Latin digits and `dir="ltr"`, so «٪100» does
              not reorder into nonsense in an Arabic or Kurdish layout.
            */}
            {/*
              AND WHERE THERE IS NO NUMBER, THERE IS NO NUMBER.

              The engine does not report how far through a mesh it is, so the
              post-dispatch wait has nothing to floor — and a percentage invented
              to fill the space would be the one thing this row must never do.
              The percent is dropped and the bar runs without a value, which is
              what `<progress>` with no `value` means natively: working, length
              unknown.
            */}
            <div><strong>{importProgress.label}</strong><small>{importProgress.extracted ? `${importProgress.extracted} ${t.objects}` : t.formatsShort}</small></div>
            {!importProgress.indeterminate && (
              <span className="import-progress-percent" dir="ltr">
                {Math.min(99, Math.max(1, Math.floor(Math.max(0, Math.min(1, importProgress.ratio)) * 100)))}%
              </span>
            )}
            {importProgress.indeterminate
              ? <progress max="1" />
              : <progress max="1" value={Math.max(0, Math.min(1, importProgress.ratio))} />}
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
        </ViewportCard>

        <TransformToolBar
          t={t}
          active={objects.length ? activeGizmo : null}
          disabled={!objects.length || status === "slicing"}
          onTool={chooseGizmo}
          onArrange={() => void arrangeAll()}
        />

        <PrintSettingsCard
          t={t}
          printerName={profile.model}
          onOpenPrinter={() => { setPrinterDraft(profileId); setSheet("printer"); }}
          material={material}
          materialInForce={t1Material}
          materials={materialsFor(profileId)}
          onMaterial={chooseMaterial}
          quality={quality}
          effectiveLayer={effectiveLayerHeight}
          onQuality={setQuality}
          strength={strength}
          effectiveInfill={effectiveInfill}
          onStrength={setStrength}
          support={support}
          onSupport={setSupport}
          disabled={!Viewport || status === "slicing"}
          showAllSettings={!simpleMode}
          onAllSettings={openAllSettings}
        />

        <ModelInfoCard
          t={t}
          dimensions={sceneFacts.dimensions}
          needsSelection={sceneFacts.needsSelection}
          orientation={sceneFacts.orientation}
          disabled={!objects.length || orienting || status === "slicing"}
          onOrient={(preset) => void orientTo(preset)}
        />

        {readiness && <ReadinessBanner t={t} kind={readiness} detail={readinessDetail} oversizedCount={oversizedCount} />}

        <PrimarySliceButton
          t={t}
          slicing={status === "slicing"}
          progress={slicing.progress}
          retrySuffix={retrySuffix}
          printReady={printReady}
          stale={currentStale}
          disabled={!objects.length || !Viewport || Boolean(importProgress)}
          onPress={primaryAction}
        />

        <ExportSection
          t={t}
          hasObjects={objects.length > 0}
          gcodeReady={printReady}
          stale={currentStale}
          gcodeCaption={`${profile.shortName} · ${t.plate} ${selectedPlate + 1}`}
          onExport3mf={saveBambuProject}
          onExportGcode={() => { downloadCurrentGcode(); }}
          onMore={printReady || currentStale ? openPrintCenter : null}
        />
      </div>

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

        A TAP ON THE BACKDROP CLOSES THE SHEET AND NOTHING ELSE (c6fix-r1-ha-01).
        The backdrop used to close the sheet on pointerdown. On a touch screen
        the click of a tap is hit-tested after pointerup, by which time the
        backdrop was gone, so the click landed on whatever sat under it: the
        back chevron left the Studio and lost the model, «حفظ» saved and
        «استيراد» opened the file picker. The sheet now closes on the click,
        and only when the press also began on the backdrop itself, so the
        whole gesture (pointerdown, pointerup and click) ends on the backdrop.
        A press that starts inside the sheet and is released outside it (a
        slider or a text selection) does not close it. The handle drag is its
        own gesture (beginSheetDrag) and is unaffected.
      */}
      {sheet && <div className="sheet-backdrop" onPointerDown={pressBackdrop} onClick={closeFromBackdrop}>
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
            <div><strong>{sheetTitle}</strong><span>{profile.shortName} · {profile.nozzle.toFixed(1)} mm · {t1Material.type || MATERIALS[material].type}</span></div>
            <button onClick={() => setSheet(null)} aria-label={t.close}><Icon name="close" /></button>
          </header>

          {sheet === "more" ? (
            <OverflowSheet
              t={t}
              locale={locale}
              onLocale={changeLocale}
              theme={studioTheme.preference}
              onTheme={studioTheme.setPreference}
              hasObjects={objects.length > 0}
              hasSelection={engineHasSelection()}
              importDisabled={!Viewport || Boolean(importProgress)}
              plateCount={plateCount}
              canvasMode={canvasMode}
              printReady={printReady}
              stale={currentStale}
              freshPlateCount={freshPlateCount}
              orienting={orienting}
              signedIn={Boolean(user?.id)}
              nativeApp={nativeEnvironment.native}
              run={runOverflow}
              onPickFiles={(files) => { setSheet(null); handlePickedFiles(files); }}
            />
          ) : sheet === "signout" ? (
            <SignOutSheet t={t} busy={signingOut} onConfirm={(purge) => void signOut(purge)} onCancel={() => setSheet(null)} />
          ) : sheet === "cut" ? (
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
          ) : sheet === "printer" ? (
            <PrinterChoiceSheet
              t={t}
              draft={printerDraft}
              onDraft={setPrinterDraft}
              onConfirm={(id) => { chooseProfile(id); setSheet(null); }}
            />
          ) : sheet === "setup" ? (
            <SetupSheet
              t={t}
              profileId={profileId}
              quality={quality}
              strength={strength}
              infill={infill}
              support={support}
              profileVerified={profileLoading ? null : (profileLoadState?.verified ?? null)}
              missingPresets={profileLoadState?.missingPresets ?? []}
              onProfile={chooseProfile}
              onQuality={setQuality}
              onStrength={setStrength}
              onInfill={setInfill}
              onSupport={setSupport}
              mode={studioMode.mode}
              onMode={studioMode.setMode}
              theme={studioTheme.preference}
              onTheme={studioTheme.setPreference}
              // In Simple mode "all settings" means Advanced: the panel it
              // opens does not exist in Simple at any width — see
              // openAllSettings, which carries the same rule:
              // if (simpleMode) studioMode.setMode("advanced");
              onOpenAdvanced={openAllSettings}
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
                // Keyed by account: a different user never inherits this
                // panel's lists, thumbnails or history (P1-09, test 02).
                key={user?.id ?? "guest"}
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
                listGuestDrafts={persistence.listGuestDraftProjects}
                onAdoptGuestDraft={persistence.adoptGuestDraftProject}
                onOpenRevisionCopy={(project, revision) => void openRevisionCopyInEditor(project, revision)}
                onRevisionRestored={(project) => void reloadAfterRevisionRestore(project)}
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
