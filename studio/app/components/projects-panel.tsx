"use client";

/**
 * «مشاريعي» — the My-Projects panel (slice S5; owner mandate §4).
 *
 * Two honest sections:
 *  - Account projects (server, per-owner): list / search / create / rename /
 *    duplicate / delete-with-confirm / open, with REAL thumbnails streamed
 *    through the worker (`/api/projects/:id/thumbnail`, ownership-checked per
 *    request) and explicit loading / empty / error states. Head snapshot kind
 *    is badged: a `source-only` head is shown as a degraded save, never as a
 *    full synced copy. Guests see a sign-in prompt — guest editing itself
 *    keeps working locally.
 *  - Drafts on this device (IndexedDB, namespaced): crash-recovery only,
 *    labeled as local — never presented as synced. Legacy drafts written by
 *    the old origin-wide store appear ONLY behind an explicit import action.
 *
 * Trilingual (ar / en / ckb) with a local reviewed dictionary; the ckb
 * strings are flagged for S6's human translation review pass. Layout uses
 * logical properties so the app chrome's RTL/LTR direction applies.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  studioProjectsApi,
  type RemoteProjectSummary,
  type StudioProjectsApi,
  StudioApiError,
} from "../project-sync";
import type { PersistenceState } from "../project-sync";
import { deleteDraft, listDrafts, type StoredLevoProject } from "../project-store";

export type PanelLocale = "ar" | "en" | "ckb";

export interface ProjectsPanelProps {
  locale: PanelLocale;
  /** Signed-in user (opaque id) or null for guest. */
  user: { id: string; displayName?: string } | null;
  /** Active local draft namespace (from use-project-persistence). */
  namespace: string;
  api?: StudioProjectsApi;
  /** Highlighted project (currently open in the editor). */
  activeRemoteProjectId?: string | null;
  activeDraftId?: string | null;
  /** Live sync state of the open project, for the status badge. */
  syncState?: PersistenceState | null;
  onOpenRemote: (project: RemoteProjectSummary) => void | Promise<void>;
  onOpenDraft: (draft: StoredLevoProject) => void | Promise<void>;
  /** Create+link is owned by the hook; the panel only asks for it. */
  onCreate: (name: string) => Promise<unknown>;
  /** Explicit legacy import (hook: importLegacyDraftProject). */
  onImportLegacy?: (id: string) => Promise<StoredLevoProject | undefined>;
  listLegacyDrafts?: () => Promise<StoredLevoProject[]>;
  onRequestSignIn?: () => void;
}

// ---------------------------------------------------------------------------
// Local dictionaries. ckb: best-effort Sorani pending S6 human review.
// ---------------------------------------------------------------------------

const TEXT = {
  ar: {
    title: "مشاريعي",
    accountTab: "حساب LEVONIS",
    deviceTab: "مسودات هذا الجهاز",
    searchPlaceholder: "ابحث في المشاريع…",
    newProjectName: "اسم المشروع الجديد",
    create: "إنشاء",
    creating: "جارٍ الإنشاء…",
    loading: "جارٍ التحميل…",
    emptyAccount: "لا توجد مشاريع محفوظة في حسابك بعد.",
    emptyAccountHint: "احفظ مشروعك الحالي في الحساب ليظهر هنا ويمكن فتحه من أي جهاز.",
    emptyDrafts: "لا توجد مسودات محلية على هذا الجهاز.",
    loadError: "تعذر تحميل المشاريع.",
    retry: "إعادة المحاولة",
    open: "فتح",
    rename: "إعادة تسمية",
    duplicate: "نسخ",
    del: "حذف",
    confirmDelete: "حذف المشروع نهائيًا؟",
    confirmYes: "نعم، احذف",
    confirmNo: "إلغاء",
    save: "حفظ",
    cancel: "إلغاء",
    updated: "آخر تعديل",
    savedToAccount: "آخر حفظ بالحساب",
    neverSaved: "لم يُحفظ بالحساب بعد",
    revision: "مراجعة",
    fullSnapshot: "نسخة كاملة",
    sourceOnly: "ملفات المصدر فقط — بدون ترتيب/تلوين",
    localDraft: "مسودة محلية — غير متزامنة",
    guestTitle: "الحفظ بالحساب يتطلب تسجيل الدخول",
    guestBody: "التحرير كضيف يعمل محليًا. سجّل الدخول بحساب LEVONIS لحفظ المشاريع في حسابك وفتحها من أي جهاز.",
    signIn: "تسجيل الدخول",
    uploadNotice: "الحفظ بالحساب يرفع ملفات المشروع إلى تخزين خاص بحسابك. لا يُنشر شيء تلقائيًا.",
    legacyTitle: "مسودات قديمة على هذا الجهاز",
    legacyBody: "مسودات من إصدار سابق. لن تُنقل تلقائيًا — استوردها بنفسك إن أردت.",
    importDraft: "استيراد",
    imported: "تم الاستيراد",
    actionFailed: "تعذر إتمام العملية.",
    noThumbnail: "بلا معاينة",
    statusUnsaved: "تغييرات غير محفوظة",
    statusSavedLocal: "محفوظ محليًا",
    statusUploading: "جارٍ الرفع…",
    statusSynced: "متزامن",
    statusFailed: "فشل الحفظ — أعد المحاولة",
    objects: "مجسمات",
    close: "إغلاق",
  },
  en: {
    title: "My Projects",
    accountTab: "LEVONIS account",
    deviceTab: "Drafts on this device",
    searchPlaceholder: "Search projects…",
    newProjectName: "New project name",
    create: "Create",
    creating: "Creating…",
    loading: "Loading…",
    emptyAccount: "No projects saved to your account yet.",
    emptyAccountHint: "Save your current project to the account to open it from any device.",
    emptyDrafts: "No local drafts on this device.",
    loadError: "Could not load projects.",
    retry: "Retry",
    open: "Open",
    rename: "Rename",
    duplicate: "Duplicate",
    del: "Delete",
    confirmDelete: "Delete this project permanently?",
    confirmYes: "Yes, delete",
    confirmNo: "Cancel",
    save: "Save",
    cancel: "Cancel",
    updated: "Last modified",
    savedToAccount: "Last account save",
    neverSaved: "Never saved to the account",
    revision: "Revision",
    fullSnapshot: "Full snapshot",
    sourceOnly: "Source files only — no arrangement/painting",
    localDraft: "Local draft — not synced",
    guestTitle: "Account saving requires sign-in",
    guestBody: "Guest editing works locally. Sign in with your LEVONIS account to save projects to your account and open them from any device.",
    signIn: "Sign in",
    uploadNotice: "Saving to the account uploads project files to private storage under your account. Nothing is published automatically.",
    legacyTitle: "Older drafts on this device",
    legacyBody: "Drafts from a previous version. They are never migrated automatically — import them yourself if you want them.",
    importDraft: "Import",
    imported: "Imported",
    actionFailed: "The action could not be completed.",
    noThumbnail: "No preview",
    statusUnsaved: "Unsaved changes",
    statusSavedLocal: "Saved locally",
    statusUploading: "Uploading…",
    statusSynced: "Synced",
    statusFailed: "Save failed — retry",
    objects: "objects",
    close: "Close",
  },
  ckb: {
    title: "پڕۆژەکانم",
    accountTab: "هەژماری LEVONIS",
    deviceTab: "ڕەشنووسەکانی ئەم ئامێرە",
    searchPlaceholder: "گەڕان لە پڕۆژەکان…",
    newProjectName: "ناوی پڕۆژەی نوێ",
    create: "دروستکردن",
    creating: "دروست دەکرێت…",
    loading: "باردەکرێت…",
    emptyAccount: "هێشتا هیچ پڕۆژەیەک لە هەژمارەکەت پاشەکەوت نەکراوە.",
    emptyAccountHint: "پڕۆژەی ئێستات لە هەژمارەکە پاشەکەوت بکە تا لێرە دەربکەوێت و لە هەر ئامێرێکەوە بکرێتەوە.",
    emptyDrafts: "هیچ ڕەشنووسێکی ناوخۆیی لەم ئامێرە نییە.",
    loadError: "بارکردنی پڕۆژەکان سەرکەوتوو نەبوو.",
    retry: "هەوڵدانەوە",
    open: "کردنەوە",
    rename: "ناوگۆڕین",
    duplicate: "لەبەرگرتنەوە",
    del: "سڕینەوە",
    confirmDelete: "ئەم پڕۆژەیە بە یەکجاری بسڕدرێتەوە؟",
    confirmYes: "بەڵێ، بیسڕەوە",
    confirmNo: "هەڵوەشاندنەوە",
    save: "پاشەکەوت",
    cancel: "هەڵوەشاندنەوە",
    updated: "دوایین گۆڕانکاری",
    savedToAccount: "دوایین پاشەکەوتی هەژمار",
    neverSaved: "هێشتا لە هەژمار پاشەکەوت نەکراوە",
    revision: "پێداچوونەوە",
    fullSnapshot: "وێنەیەکی تەواو",
    sourceOnly: "تەنها فایلە سەرچاوەکان — بێ ڕیزکردن/ڕەنگکردن",
    localDraft: "ڕەشنووسی ناوخۆیی — هاوکات نەکراوە",
    guestTitle: "پاشەکەوتکردن لە هەژمار پێویستی بە چوونەژوورەوەیە",
    guestBody: "دەستکاریکردن وەک میوان بە شێوەی ناوخۆیی کاردەکات. بە هەژماری LEVONIS بچۆرە ژوورەوە بۆ پاشەکەوتکردنی پڕۆژەکان لە هەژمارەکەت و کردنەوەیان لە هەر ئامێرێکەوە.",
    signIn: "چوونەژوورەوە",
    uploadNotice: "پاشەکەوتکردن لە هەژمار فایلەکانی پڕۆژە بار دەکات بۆ کۆگایەکی تایبەت بە هەژمارەکەت. هیچ شتێک بە خۆکاری بڵاو ناکرێتەوە.",
    legacyTitle: "ڕەشنووسە کۆنەکانی ئەم ئامێرە",
    legacyBody: "ڕەشنووسی وەشانێکی پێشوو. بە خۆکاری ناگوازرێنەوە — خۆت هاوردەیان بکە ئەگەر دەتەوێت.",
    importDraft: "هاوردەکردن",
    imported: "هاوردە کرا",
    actionFailed: "کردارەکە تەواو نەبوو.",
    noThumbnail: "بێ پێشبینین",
    statusUnsaved: "گۆڕانکاری پاشەکەوتنەکراو",
    statusSavedLocal: "بە ناوخۆیی پاشەکەوت کراوە",
    statusUploading: "بار دەکرێت…",
    statusSynced: "هاوکات کراوە",
    statusFailed: "پاشەکەوت سەرکەوتوو نەبوو — هەوڵبدەوە",
    objects: "تەنەکان",
    close: "داخستن",
  },
} as const;

type PanelText = { [K in keyof (typeof TEXT)["en"]]: string };

const DATE_LOCALES: Record<PanelLocale, string> = { ar: "ar-IQ", en: "en", ckb: "ckb-IQ" };

function formatDate(value: string | number | null | undefined, locale: PanelLocale): string {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return date.toLocaleString(DATE_LOCALES[locale], { dateStyle: "short", timeStyle: "short" });
  } catch {
    return date.toLocaleString("en");
  }
}

function statusLabel(state: PersistenceState, t: PanelText): string {
  switch (state.status) {
    case "unsaved":
      return t.statusUnsaved;
    case "saved-local":
      return t.statusSavedLocal;
    case "uploading":
      return t.statusUploading;
    case "synced":
      return t.statusSynced;
    case "failed":
      return t.statusFailed;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoadPhase = "loading" | "ready" | "error";

export default function ProjectsPanel(props: ProjectsPanelProps) {
  const { locale, user, namespace, activeRemoteProjectId, activeDraftId, syncState } = props;
  const api = props.api ?? studioProjectsApi;
  const t: PanelText = TEXT[locale] ?? TEXT.ar;

  const [tab, setTab] = useState<"account" | "device">(user ? "account" : "device");
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<RemoteProjectSummary[]>([]);
  const [remotePhase, setRemotePhase] = useState<LoadPhase>("loading");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<StoredLevoProject[]>([]);
  const [draftsPhase, setDraftsPhase] = useState<LoadPhase>("loading");
  const [legacy, setLegacy] = useState<StoredLevoProject[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [brokenThumbs, setBrokenThumbs] = useState<ReadonlySet<string>>(new Set());
  const reloadTokenRef = useRef(0);

  // -- account project list (search debounced) ------------------------------

  const loadRemote = useCallback(
    (q: string) => {
      if (!user) {
        setRemote([]);
        setRemotePhase("ready");
        return () => {};
      }
      const token = ++reloadTokenRef.current;
      const controller = new AbortController();
      setRemotePhase("loading");
      setRemoteError(null);
      api
        .listProjects({ q: q || undefined, limit: 100, signal: controller.signal })
        .then((projects) => {
          if (reloadTokenRef.current !== token) return;
          setRemote(projects);
          setRemotePhase("ready");
        })
        .catch((error: unknown) => {
          if (reloadTokenRef.current !== token || controller.signal.aborted) return;
          setRemotePhase("error");
          setRemoteError(
            error instanceof StudioApiError && error.status === 401
              ? t.guestTitle
              : error instanceof Error
                ? error.message
                : t.loadError
          );
        });
      return () => controller.abort();
    },
    [api, t.guestTitle, t.loadError, user]
  );

  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const handle = setTimeout(() => {
      cleanupRef.current = loadRemote(query.trim());
    }, query ? 300 : 0);
    return () => {
      clearTimeout(handle);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [loadRemote, query]);

  // -- local drafts ----------------------------------------------------------

  const loadDraftsList = useCallback(async () => {
    setDraftsPhase("loading");
    try {
      setDrafts(await listDrafts(namespace));
      setDraftsPhase("ready");
    } catch {
      setDrafts([]);
      setDraftsPhase("error");
    }
    try {
      setLegacy(props.listLegacyDrafts ? await props.listLegacyDrafts() : []);
    } catch {
      setLegacy([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, props.listLegacyDrafts]);

  useEffect(() => {
    void loadDraftsList();
  }, [loadDraftsList]);

  // -- actions ---------------------------------------------------------------

  const runAction = useCallback(
    async (id: string, action: () => Promise<void>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await action();
      } catch (error: unknown) {
        setActionError(error instanceof Error ? error.message : t.actionFailed);
      } finally {
        setBusyId(null);
      }
    },
    [t.actionFailed]
  );

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      await props.onCreate(name);
      setNewName("");
      loadRemote(query.trim());
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : t.actionFailed);
    } finally {
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, loadRemote, newName, props.onCreate, query, t.actionFailed]);

  const handleRename = useCallback(
    (project: RemoteProjectSummary) =>
      runAction(project.id, async () => {
        const name = renameValue.trim();
        if (!name) return;
        const updated = await api.renameProject(project.id, name);
        setRemote((current) => current.map((p) => (p.id === project.id ? updated : p)));
        setRenamingId(null);
      }),
    [api, renameValue, runAction]
  );

  const handleDuplicate = useCallback(
    (project: RemoteProjectSummary) =>
      runAction(project.id, async () => {
        const copy = await api.duplicateProject(project.id);
        setRemote((current) => [copy, ...current]);
      }),
    [api, runAction]
  );

  const handleDelete = useCallback(
    (project: RemoteProjectSummary) =>
      runAction(project.id, async () => {
        await api.deleteProject(project.id);
        setRemote((current) => current.filter((p) => p.id !== project.id));
        setConfirmDeleteId(null);
      }),
    [api, runAction]
  );

  const handleDeleteDraft = useCallback(
    (draft: StoredLevoProject) =>
      runAction(draft.id, async () => {
        await deleteDraft(namespace, draft.id);
        setDrafts((current) => current.filter((d) => d.id !== draft.id));
        setConfirmDeleteId(null);
      }),
    [namespace, runAction]
  );

  const handleImportLegacy = useCallback(
    (draft: StoredLevoProject) =>
      runAction(`legacy:${draft.id}`, async () => {
        if (!props.onImportLegacy) return;
        const imported = await props.onImportLegacy(draft.id);
        if (imported) {
          setLegacy((current) => current.filter((d) => d.id !== draft.id));
          await loadDraftsList();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadDraftsList, props.onImportLegacy, runAction]
  );

  const markThumbBroken = useCallback((id: string) => {
    setBrokenThumbs((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const draftThumbUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const draft of drafts) {
      if (draft.thumbnail instanceof Blob) map.set(draft.id, URL.createObjectURL(draft.thumbnail));
    }
    return map;
  }, [drafts]);
  useEffect(
    () => () => {
      for (const url of draftThumbUrls.values()) URL.revokeObjectURL(url);
    },
    [draftThumbUrls]
  );

  // -- render ----------------------------------------------------------------

  const renderThumb = (src: string | null, alt: string) =>
    src ? (
      <img className="lpp-thumb" src={src} alt={alt} loading="lazy" />
    ) : (
      <span className="lpp-thumb lpp-thumb-empty" aria-label={t.noThumbnail}>◫</span>
    );

  const kindBadge = (kind: "full" | "source-only" | null | undefined) => {
    if (kind === "full") return <span className="lpp-badge lpp-badge-full">{t.fullSnapshot}</span>;
    if (kind === "source-only") return <span className="lpp-badge lpp-badge-degraded">{t.sourceOnly}</span>;
    return null;
  };

  const remoteCard = (project: RemoteProjectSummary) => {
    const isActive = project.id === activeRemoteProjectId;
    const busy = busyId === project.id;
    const thumbSrc = project.has_thumbnail && !brokenThumbs.has(project.id) ? api.thumbnailUrl(project.id) : null;
    return (
      <li key={project.id} className={`lpp-card${isActive ? " lpp-card-active" : ""}`}>
        <button
          type="button"
          className="lpp-thumb-btn"
          onClick={() => void props.onOpenRemote(project)}
          disabled={busy}
          aria-label={`${t.open}: ${project.name}`}
        >
          {project.has_thumbnail && !brokenThumbs.has(project.id) ? (
            <img
              className="lpp-thumb"
              src={thumbSrc ?? undefined}
              alt=""
              loading="lazy"
              onError={() => markThumbBroken(project.id)}
            />
          ) : (
            <span className="lpp-thumb lpp-thumb-empty">◫</span>
          )}
        </button>
        <div className="lpp-card-body">
          {renamingId === project.id ? (
            <div className="lpp-rename">
              <input
                value={renameValue}
                maxLength={120}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRename(project);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                autoFocus
              />
              <button type="button" onClick={() => void handleRename(project)} disabled={busy}>{t.save}</button>
              <button type="button" onClick={() => setRenamingId(null)}>{t.cancel}</button>
            </div>
          ) : (
            <strong className="lpp-name">{project.name}</strong>
          )}
          <small className="lpp-meta">
            {t.updated}: {formatDate(project.updated_at, locale)}
            {" · "}
            {project.last_saved_at
              ? `${t.savedToAccount}: ${formatDate(project.last_saved_at, locale)} · ${t.revision} ${project.head_revision ?? "—"}`
              : t.neverSaved}
          </small>
          <div className="lpp-badges">
            {kindBadge(project.head_snapshot_kind)}
            {isActive && syncState ? (
              <span className={`lpp-badge lpp-status lpp-status-${syncState.status}`}>{statusLabel(syncState, t)}</span>
            ) : null}
          </div>
          {confirmDeleteId === project.id ? (
            <div className="lpp-confirm" role="alertdialog" aria-label={t.confirmDelete}>
              <span>{t.confirmDelete}</span>
              <button type="button" className="lpp-danger" onClick={() => void handleDelete(project)} disabled={busy}>
                {t.confirmYes}
              </button>
              <button type="button" onClick={() => setConfirmDeleteId(null)}>{t.confirmNo}</button>
            </div>
          ) : (
            <div className="lpp-actions">
              <button type="button" onClick={() => void props.onOpenRemote(project)} disabled={busy}>{t.open}</button>
              <button
                type="button"
                onClick={() => {
                  setRenamingId(project.id);
                  setRenameValue(project.name);
                }}
                disabled={busy}
              >
                {t.rename}
              </button>
              <button type="button" onClick={() => void handleDuplicate(project)} disabled={busy}>{t.duplicate}</button>
              <button type="button" className="lpp-danger" onClick={() => setConfirmDeleteId(project.id)} disabled={busy}>
                {t.del}
              </button>
            </div>
          )}
        </div>
      </li>
    );
  };

  const draftCard = (draft: StoredLevoProject, legacyDraft: boolean) => {
    const busy = busyId === (legacyDraft ? `legacy:${draft.id}` : draft.id);
    const thumbUrl = !legacyDraft ? draftThumbUrls.get(draft.id) ?? null : null;
    const kind = draft.snapshotKind ?? (draft.snapshotVersion === 2 ? "full" : "source-only");
    return (
      <li key={`${legacyDraft ? "legacy" : "draft"}:${draft.id}`} className={`lpp-card${draft.id === activeDraftId && !legacyDraft ? " lpp-card-active" : ""}`}>
        <span className="lpp-thumb-btn" aria-hidden="true">{renderThumb(thumbUrl, "")}</span>
        <div className="lpp-card-body">
          <strong className="lpp-name">{draft.name}</strong>
          <small className="lpp-meta">
            {t.updated}: {formatDate(draft.updatedAt, locale)}
            {" · "}
            {draft.objectCount ?? draft.files.length} {t.objects}
          </small>
          <div className="lpp-badges">
            <span className="lpp-badge lpp-badge-local">{t.localDraft}</span>
            {kindBadge(kind)}
          </div>
          {confirmDeleteId === draft.id && !legacyDraft ? (
            <div className="lpp-confirm" role="alertdialog" aria-label={t.confirmDelete}>
              <span>{t.confirmDelete}</span>
              <button type="button" className="lpp-danger" onClick={() => void handleDeleteDraft(draft)} disabled={busy}>
                {t.confirmYes}
              </button>
              <button type="button" onClick={() => setConfirmDeleteId(null)}>{t.confirmNo}</button>
            </div>
          ) : (
            <div className="lpp-actions">
              {legacyDraft ? (
                <button type="button" onClick={() => void handleImportLegacy(draft)} disabled={busy || !props.onImportLegacy}>
                  {t.importDraft}
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => void props.onOpenDraft(draft)} disabled={busy}>{t.open}</button>
                  <button type="button" className="lpp-danger" onClick={() => setConfirmDeleteId(draft.id)} disabled={busy}>
                    {t.del}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="levo-projects-panel" aria-label={t.title}>
      <style>{PANEL_CSS}</style>
      <header className="lpp-header">
        <h2>{t.title}</h2>
        <div className="lpp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "account"}
            className={tab === "account" ? "lpp-tab-active" : ""}
            onClick={() => setTab("account")}
          >
            {t.accountTab}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "device"}
            className={tab === "device" ? "lpp-tab-active" : ""}
            onClick={() => setTab("device")}
          >
            {t.deviceTab}
          </button>
        </div>
      </header>

      {actionError ? <p className="lpp-error" role="alert">{actionError}</p> : null}

      {tab === "account" ? (
        user ? (
          <>
            <div className="lpp-toolbar">
              <input
                type="search"
                value={query}
                placeholder={t.searchPlaceholder}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t.searchPlaceholder}
              />
              <div className="lpp-create">
                <input
                  value={newName}
                  maxLength={120}
                  placeholder={t.newProjectName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreate();
                  }}
                  aria-label={t.newProjectName}
                />
                <button type="button" onClick={() => void handleCreate()} disabled={creating || !newName.trim()}>
                  {creating ? t.creating : t.create}
                </button>
              </div>
            </div>
            <p className="lpp-notice">{t.uploadNotice}</p>
            {remotePhase === "loading" ? (
              <p className="lpp-state" aria-busy="true">{t.loading}</p>
            ) : remotePhase === "error" ? (
              <div className="lpp-state lpp-state-error" role="alert">
                <p>{remoteError ?? t.loadError}</p>
                <button type="button" onClick={() => loadRemote(query.trim())}>{t.retry}</button>
              </div>
            ) : remote.length === 0 ? (
              <div className="lpp-state">
                <p>{t.emptyAccount}</p>
                <small>{t.emptyAccountHint}</small>
              </div>
            ) : (
              <ul className="lpp-grid">{remote.map(remoteCard)}</ul>
            )}
          </>
        ) : (
          <div className="lpp-state lpp-guest">
            <h3>{t.guestTitle}</h3>
            <p>{t.guestBody}</p>
            {props.onRequestSignIn ? (
              <button type="button" className="lpp-primary" onClick={props.onRequestSignIn}>{t.signIn}</button>
            ) : null}
          </div>
        )
      ) : (
        <>
          {draftsPhase === "loading" ? (
            <p className="lpp-state" aria-busy="true">{t.loading}</p>
          ) : draftsPhase === "error" ? (
            <div className="lpp-state lpp-state-error" role="alert">
              <p>{t.loadError}</p>
              <button type="button" onClick={() => void loadDraftsList()}>{t.retry}</button>
            </div>
          ) : drafts.length === 0 ? (
            <p className="lpp-state">{t.emptyDrafts}</p>
          ) : (
            <ul className="lpp-grid">{drafts.map((draft) => draftCard(draft, false))}</ul>
          )}
          {legacy.length > 0 ? (
            <div className="lpp-legacy">
              <h3>{t.legacyTitle}</h3>
              <p>{t.legacyBody}</p>
              <ul className="lpp-grid">{legacy.map((draft) => draftCard(draft, true))}</ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Scoped styles: logical properties for RTL/LTR; theme overridable via
// --levo-* tokens (S6's theme file can restyle without touching this file).
// ---------------------------------------------------------------------------

const PANEL_CSS = `
.levo-projects-panel{display:flex;flex-direction:column;gap:12px;color:var(--levo-panel-fg,#e8eaf0);font-size:14px}
.levo-projects-panel .lpp-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.levo-projects-panel h2{margin:0;font-size:18px}
.levo-projects-panel h3{margin:0 0 4px;font-size:15px}
.levo-projects-panel .lpp-tabs{display:flex;gap:4px;background:var(--levo-panel-inset,#1a1d24);border-radius:10px;padding:3px}
.levo-projects-panel .lpp-tabs button{border:0;background:transparent;color:inherit;padding:7px 12px;border-radius:8px;cursor:pointer;min-height:40px}
.levo-projects-panel .lpp-tabs .lpp-tab-active{background:var(--levo-accent,#3d6ef7);color:#fff}
.levo-projects-panel .lpp-toolbar{display:flex;flex-wrap:wrap;gap:8px}
.levo-projects-panel input{background:var(--levo-panel-inset,#1a1d24);color:inherit;border:1px solid var(--levo-panel-border,#2a2f3a);border-radius:8px;padding:9px 10px;min-height:40px;flex:1;min-inline-size:140px}
.levo-projects-panel .lpp-create{display:flex;gap:6px;flex:1;min-inline-size:220px}
.levo-projects-panel button{border:1px solid var(--levo-panel-border,#2a2f3a);background:var(--levo-panel-inset,#1a1d24);color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer;min-height:40px}
.levo-projects-panel button:disabled{opacity:.5;cursor:default}
.levo-projects-panel .lpp-primary{background:var(--levo-accent,#3d6ef7);border-color:transparent;color:#fff}
.levo-projects-panel .lpp-danger{color:var(--levo-danger,#ff7a76)}
.levo-projects-panel .lpp-notice{margin:0;font-size:12px;opacity:.75}
.levo-projects-panel .lpp-error{margin:0;color:var(--levo-danger,#ff7a76)}
.levo-projects-panel .lpp-state{padding:24px 8px;text-align:center;opacity:.85}
.levo-projects-panel .lpp-state small{display:block;margin-top:4px;opacity:.7}
.levo-projects-panel .lpp-state-error button{margin-top:8px}
.levo-projects-panel .lpp-guest{display:flex;flex-direction:column;align-items:center;gap:8px}
.levo-projects-panel .lpp-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.levo-projects-panel .lpp-card{display:flex;gap:10px;background:var(--levo-panel-card,#171a20);border:1px solid var(--levo-panel-border,#2a2f3a);border-radius:12px;padding:10px}
.levo-projects-panel .lpp-card-active{border-color:var(--levo-accent,#3d6ef7)}
.levo-projects-panel .lpp-thumb-btn{border:0;background:transparent;padding:0;flex:none;cursor:pointer}
.levo-projects-panel .lpp-thumb{inline-size:72px;block-size:54px;border-radius:8px;object-fit:cover;background:var(--levo-panel-inset,#1a1d24);display:flex;align-items:center;justify-content:center;font-size:22px;opacity:.9}
.levo-projects-panel .lpp-thumb-empty{opacity:.4}
.levo-projects-panel .lpp-card-body{display:flex;flex-direction:column;gap:5px;min-inline-size:0;flex:1}
.levo-projects-panel .lpp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.levo-projects-panel .lpp-meta{opacity:.7;font-size:11.5px}
.levo-projects-panel .lpp-badges{display:flex;flex-wrap:wrap;gap:4px}
.levo-projects-panel .lpp-badge{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--levo-panel-inset,#1a1d24);border:1px solid var(--levo-panel-border,#2a2f3a)}
.levo-projects-panel .lpp-badge-full{border-color:var(--levo-ok,#3fbf6f);color:var(--levo-ok,#3fbf6f)}
.levo-projects-panel .lpp-badge-degraded{border-color:var(--levo-warn,#e2a93b);color:var(--levo-warn,#e2a93b)}
.levo-projects-panel .lpp-badge-local{opacity:.8}
.levo-projects-panel .lpp-status-synced{border-color:var(--levo-ok,#3fbf6f);color:var(--levo-ok,#3fbf6f)}
.levo-projects-panel .lpp-status-uploading{border-color:var(--levo-accent,#3d6ef7);color:var(--levo-accent,#8fb0ff)}
.levo-projects-panel .lpp-status-failed{border-color:var(--levo-danger,#ff7a76);color:var(--levo-danger,#ff7a76)}
.levo-projects-panel .lpp-actions,.levo-projects-panel .lpp-confirm,.levo-projects-panel .lpp-rename{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.levo-projects-panel .lpp-actions button,.levo-projects-panel .lpp-confirm button,.levo-projects-panel .lpp-rename button{padding:5px 10px;min-height:36px;font-size:12.5px}
.levo-projects-panel .lpp-confirm span{font-size:12.5px;color:var(--levo-danger,#ff7a76)}
.levo-projects-panel .lpp-rename input{min-height:36px;padding:5px 8px}
.levo-projects-panel .lpp-legacy{border-top:1px dashed var(--levo-panel-border,#2a2f3a);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.levo-projects-panel .lpp-legacy p{margin:0;font-size:12px;opacity:.75}
@media (max-width:520px){.levo-projects-panel .lpp-grid{grid-template-columns:1fr}}
`;
