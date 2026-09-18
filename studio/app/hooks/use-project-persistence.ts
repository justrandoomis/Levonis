"use client";

/**
 * use-project-persistence (slice S5) — the React face of the client sync
 * layer (docs/STUDIO_PLAN.md decision 4, owner mandate §4).
 *
 * Owns, per signed-in user (or guest):
 *  - the draft NAMESPACE: crash-recovery drafts are written under
 *    `user:<id>` / `guest`; switching accounts rebuilds the controller and
 *    the store bridge so no timer, in-flight upload, or draft ever crosses
 *    into another namespace;
 *  - the debounced autosave/upload state machine (ProjectSyncController) and
 *    its five visible states — "synced" only ever after a COMMIT 200;
 *  - conflict resolution with a real user choice (overwrite-by-rebase or
 *    keep the server version) — never a silent overwrite;
 *  - opening account projects (download head revision, honestly labeled
 *    full vs source-only) and explicit import of legacy local drafts.
 *
 * The editor shell provides capture callbacks (engine 3MF export, source
 * files, canvas thumbnail, manifest) and receives files to dispatch — this
 * hook never touches the engine DOM itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProjectSyncController,
  openRemoteProject,
  studioProjectsApi,
  type ConflictResolution,
  type OpenedRemoteProject,
  type PersistenceState,
  type ProjectManifest,
  type ProjectSyncCallbacks,
  type RemoteProjectSummary,
  type SnapshotCapture,
  type SnapshotKind,
  type StudioProjectsApi,
} from "../project-sync";
import {
  importLegacyDraft,
  listLegacyDrafts,
  namespaceForUser,
  saveDraft,
  setActiveDraftNamespace,
  type StoredLevoProject,
} from "../project-store";

export interface PersistenceUser {
  id: string;
}

export interface UseProjectPersistenceOptions {
  /** Signed-in Studio user (opaque id) or null for guest editing. */
  user: PersistenceUser | null;
  /** Engine full-snapshot export (3MF); resolve null on failure/timeout. */
  captureSnapshot: () => Promise<SnapshotCapture | null>;
  /** Raw source files currently loaded (degraded-save fallback). */
  getSourceFiles: () => File[];
  /** Real viewport thumbnail or null (see thumbnail.ts). */
  captureThumbnail?: () => Promise<Blob | null>;
  /** Manifest for the revision being saved (plan decision 4 contents). */
  buildManifest: (kind: SnapshotKind) => ProjectManifest;
  /** Local draft fields the shell owns (name, profile, settings, counts…). */
  buildDraft: (payload: {
    files: File[];
    kind: SnapshotKind;
    contentHash: string | null;
    thumbnail: Blob | null;
  }) => StoredLevoProject;
  getMeta: () => { schemaVersion: number; engineVersion?: string };
  /**
   * Cheap fingerprint of everything that would change the saved snapshot. When
   * it matches the last completed full save, the controller skips the whole
   * capture (see ProjectSyncCallbacks.contentSignature). Return null to always
   * save.
   */
  contentSignature?: () => string | null;
  /**
   * True while a DEBOUNCED autosave must wait — see the doc comment on
   * ProjectSyncCallbacks.busy in app/project-sync.ts. The shell answers "a
   * slice is running": the capture is a full 3MF export on the main thread,
   * and on a phone that is exactly what the slice worker does not survive.
   */
  busy?: () => boolean;
  debounceMs?: number;
  api?: StudioProjectsApi;
}

export interface UseProjectPersistenceResult {
  /** Live sync state — drives the five distinct status indicators. */
  state: PersistenceState;
  /** Draft namespace currently active (exposed for the projects panel). */
  namespace: string;
  /** Call on every scene/settings edit signal; debounces a save. */
  markDirty: () => void;
  /** Manual save now (local draft + upload when signed in and linked). */
  saveNow: () => Promise<void>;
  /** Manual retry after a failed upload. */
  retryNow: () => Promise<void>;
  /** Resolve a 409 conflict with an explicit user choice. */
  resolveConflict: (choice: ConflictResolution) => Promise<void>;
  /** Link the editor session to an account project (after create/open). */
  linkRemoteProject: (projectId: string, baseRevision: number | null) => void;
  unlinkRemoteProject: () => void;
  /** Create an account project and link the session to it. Requires sign-in. */
  createRemoteProjectAndLink: (name: string) => Promise<RemoteProjectSummary>;
  /**
   * Download an account project's head revision (ownership enforced by the
   * server). Links the session and returns the restorable files — the shell
   * dispatches them to the engine and applies manifest settings. The result's
   * snapshotKind MUST be surfaced when "source-only" (degraded restore).
   */
  openAccountProject: (projectId: string) => Promise<OpenedRemoteProject>;
  /** Legacy origin-wide drafts — listed only for the explicit import UI. */
  listLegacyDraftProjects: () => Promise<StoredLevoProject[]>;
  /** EXPLICIT user action: move a legacy draft into the active namespace. */
  importLegacyDraftProject: (id: string) => Promise<StoredLevoProject | undefined>;
}

const INITIAL_STATE: PersistenceState = {
  status: "unsaved",
  dirty: false,
  guest: true,
  remoteProjectId: null,
  lastLocalSaveAt: null,
  lastLocalKind: null,
  lastSyncedRevision: null,
  lastSyncedAt: null,
  lastSyncedKind: null,
  conflict: null,
  failure: null,
  retryCount: 0,
  nextRetryAt: null,
};

export function useProjectPersistence(options: UseProjectPersistenceOptions): UseProjectPersistenceResult {
  const userId = options.user?.id ?? null;
  const namespace = useMemo(() => namespaceForUser(userId), [userId]);
  const api = options.api ?? studioProjectsApi;

  const [state, setState] = useState<PersistenceState>({ ...INITIAL_STATE, guest: userId === null });
  const controllerRef = useRef<ProjectSyncController | null>(null);

  // Latest callbacks without re-creating the controller on each render.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    // Account switch/logout boundary: the store bridge follows the namespace
    // and the previous controller is disposed (timers cleared, uploads
    // aborted) BEFORE a new one exists — mandate §4 / acceptance test T5.
    setActiveDraftNamespace(namespace);

    const callbacks: ProjectSyncCallbacks = {
      captureSnapshot: () => callbacksRef.current.captureSnapshot(),
      getSourceFiles: () => callbacksRef.current.getSourceFiles(),
      captureThumbnail: () => callbacksRef.current.captureThumbnail?.() ?? Promise.resolve(null),
      buildManifest: (kind) => callbacksRef.current.buildManifest(kind),
      getMeta: () => callbacksRef.current.getMeta(),
      contentSignature: () => callbacksRef.current.contentSignature?.() ?? null,
      busy: () => callbacksRef.current.busy?.() === true,
      persistDraft: async (payload) => {
        const draft = callbacksRef.current.buildDraft(payload);
        await saveDraft(namespace, draft);
      },
    };

    const controller = new ProjectSyncController({
      userId,
      callbacks,
      debounceMs: callbacksRef.current.debounceMs,
      api,
    });
    controllerRef.current = controller;
    setState(controller.getState());
    const unsubscribe = controller.subscribe(setState);

    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The controller is identity-bound to the user/namespace only; callbacks
    // flow through callbacksRef, which is why none of them appear here.
  }, [userId, namespace, api]);

  const markDirty = useCallback(() => {
    controllerRef.current?.markDirty();
  }, []);

  const saveNow = useCallback(async () => {
    await controllerRef.current?.saveNow();
  }, []);

  const retryNow = useCallback(async () => {
    await controllerRef.current?.retryNow();
  }, []);

  const resolveConflict = useCallback(async (choice: ConflictResolution) => {
    await controllerRef.current?.resolveConflict(choice);
  }, []);

  const linkRemoteProject = useCallback((projectId: string, baseRevision: number | null) => {
    controllerRef.current?.linkRemoteProject(projectId, baseRevision);
  }, []);

  const unlinkRemoteProject = useCallback(() => {
    controllerRef.current?.unlinkRemoteProject();
  }, []);

  const createRemoteProjectAndLink = useCallback(
    async (name: string): Promise<RemoteProjectSummary> => {
      const project = await api.createProject(name);
      controllerRef.current?.linkRemoteProject(project.id, project.head_revision ?? null);
      return project;
    },
    [api]
  );

  const openAccountProject = useCallback(
    async (projectId: string): Promise<OpenedRemoteProject> => {
      const opened = await openRemoteProject(projectId, { api });
      controllerRef.current?.linkRemoteProject(
        opened.project.id,
        opened.revision?.revision ?? null,
        opened.revision
          ? { hash: opened.revision.content_hash ?? null, kind: opened.snapshotKind, at: Date.now() }
          : undefined
      );
      return opened;
    },
    [api]
  );

  const listLegacyDraftProjects = useCallback(() => listLegacyDrafts(), []);

  const importLegacyDraftProject = useCallback(
    (id: string) => importLegacyDraft(id, namespace),
    [namespace]
  );

  return {
    state,
    namespace,
    markDirty,
    saveNow,
    retryNow,
    resolveConflict,
    linkRemoteProject,
    unlinkRemoteProject,
    createRemoteProjectAndLink,
    openAccountProject,
    listLegacyDraftProjects,
    importLegacyDraftProject,
  };
}
