"use client";

/**
 * LEVO Studio header (slice S6) — extracted from the slicer-client monolith.
 *
 * Presentational only: every action is a callback into the shell. Also home of
 * the shared `Icon` set and the `FileSelectControl` label/input pair used by
 * the shell and the sheets.
 *
 * Honest states carried here:
 * - the status pill mirrors the real editor state (loading/slicing %/ready
 *   layers/stale/error) — never a fabricated progress number;
 * - there is NO APK download action (mandate §12) — the "full LEVONIS app"
 *   message lives in the About/Connect sheets as an explicitly disabled state;
 * - sign-in/out link to the S2 worker routes (`/auth/login`, `/auth/logout`),
 *   not to the retired ChatGPT-hosting paths.
 */

import type { ReactNode } from "react";
import { LOCALES, LOCALE_NAMES, type Locale, type StudioDictionary } from "../i18n";
import { FILE_PICKER_ACCEPT } from "../archive-import";

export type IconName =
  | "plus" | "file" | "move" | "rotate" | "scale" | "copy" | "trash" | "fit"
  | "bed" | "layers" | "slice" | "print" | "save" | "share" | "undo" | "redo"
  | "split" | "paint" | "info" | "settings" | "close" | "check" | "external"
  | "arrange" | "warning";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    file: <><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/></>,
    move: <><path d="M12 2v20"/><path d="m8 6 4-4 4 4"/><path d="m8 18 4 4 4-4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/><path d="m18 8 4 4-4 4"/></>,
    rotate: <><path d="M20 7v5h-5"/><path d="M18.5 16a8 8 0 1 1 .8-8.8L20 12"/></>,
    scale: <><path d="M8 3H3v5"/><path d="m3 3 7 7"/><path d="M16 21h5v-5"/><path d="m21 21-7-7"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    trash: <><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></>,
    fit: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></>,
    bed: <><path d="M3 7h18v12H3z"/><path d="M7 3v4M17 3v4"/><path d="M7 11h10M7 15h6"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></>,
    slice: <><path d="M4 6h16M4 12h16M4 18h16"/><path d="m8 3 8 18"/></>,
    print: <><path d="M7 8V3h10v5"/><path d="M6 17H4v-7h16v7h-2"/><path d="M7 14h10v7H7z"/><path d="M17 11h.01"/></>,
    save: <><path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3"/><path d="M8 15h8"/></>,
    share: <><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.2M8.7 13.3l6.6 4.2"/></>,
    undo: <><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
    redo: <><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
    split: <><path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="m11 11 2 2M14 6h4v4M10 18H6v-4"/></>,
    paint: <><path d="m14 4 6 6-9 9H5v-6z"/><path d="m12 6 6 6M5 19c0 1-1 2-2 2"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    settings: <><path d="M4 7h10M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2M10 17h10"/><circle cx="8" cy="17" r="2"/></>,
    close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
    arrange: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><path d="M17 13v8M13 17h8"/></>,
    warning: <><path d="m12 3 10 18H2z"/><path d="M12 10v5M12 18h.01"/></>,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function FileSelectControl({
  children,
  className,
  disabled = false,
  label,
  onFiles,
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  label: string;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label className={`${className} file-select-control`} aria-disabled={disabled}>
      <input
        className="native-file-input"
        type="file"
        multiple
        disabled={disabled}
        aria-label={label}
        data-supported-formats={FILE_PICKER_ACCEPT}
        onClick={(event) => { event.currentTarget.value = ""; }}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) onFiles(files);
        }}
      />
      {children}
    </label>
  );
}

/** S2 auth-handoff routes on the Studio worker (never the retired oai paths). */
export const SIGN_IN_HREF = "/auth/login?return_to=%2F";
export const SIGN_OUT_HREF = "/auth/logout?return_to=%2F";

export interface StudioHeaderProps {
  t: StudioDictionary;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  /** Signed-in Studio user (display name only reaches the client). */
  user: { displayName: string } | null;
  /** True inside the Capacitor app; the web sign-in links are hidden there. */
  nativeApp: boolean;
  projectName: string;
  objectCount: number;
  selectedPlate: number;
  plateCount: number;
  status: "loading" | "editing" | "slicing" | "ready" | "error";
  statusLabel: string;
  /** True while the requested preset is still being loaded/applied. */
  profileLoading: boolean;
  /** False when the loaded preset fell back to generic settings. */
  profileVerified: boolean;
  profileShortName: string;
  qualityLayer: number;
  engineReady: boolean;
  importBusy: boolean;
  printReady: boolean;
  sidebarOpen: boolean;
  onPickFiles: (files: File[]) => void;
  onNewProject: () => void;
  onOpenProjects: () => void;
  onOpenPrintCenter: () => void;
  onOpenSetup: () => void;
  onOpenConnect: () => void;
  onOpenAbout: () => void;
  onToggleSidebar: () => void;
}

export default function StudioHeader(props: StudioHeaderProps) {
  const { t } = props;
  return (
    <header className="studio-header">
      <button className="studio-brand" onClick={props.onOpenAbout} aria-label={t.about}><span>LE</span></button>
      <div className="studio-project">
        <strong>{t.title}</strong>
        <span>
          {props.objectCount
            ? `${props.projectName} · ${props.objectCount} ${t.objects} · ${t.plate} ${props.selectedPlate + 1}/${props.plateCount}`
            : t.newProject}
        </span>
      </div>
      <div className="studio-status" data-status={props.status}>
        <i />
        <span>{props.profileLoading ? t.profileLoading : props.statusLabel}</span>
        {!props.profileLoading && !props.profileVerified && <em className="status-preset-warning" title={t.presetFallbackWarning}><Icon name="warning" /></em>}
      </div>
      <div className="studio-actions">
        <FileSelectControl className="import-action" label={t.files} disabled={!props.engineReady || props.importBusy} onFiles={props.onPickFiles}>
          <Icon name="file" /><span>{t.files}</span>
        </FileSelectControl>
        <button className="new-project-action" onClick={props.onNewProject} title={t.newProject}><Icon name="plus" /><span>{t.newProject}</span></button>
        <button onClick={props.onOpenProjects} title={t.projects}><Icon name="save" /><span>{t.projects}</span></button>
        {props.printReady && <button className="header-print-action" onClick={props.onOpenPrintCenter}><Icon name="print" /><span>{t.print}</span></button>}
        <button className="connect-action" onClick={props.onOpenConnect} title={t.connectPrinter}><Icon name="print" /><span>{t.connectPrinter}</span></button>
        {!props.nativeApp && (props.user
          ? <a href={SIGN_OUT_HREF} title={props.user.displayName}><Icon name="check" /><span>{t.signOut}</span></a>
          : <a href={SIGN_IN_HREF}><Icon name="info" /><span>{t.signIn}</span></a>)}
        <button className="profile-button" onClick={props.onOpenSetup} title={t.settings}>
          <b>{props.profileShortName}</b><small>{props.qualityLayer.toFixed(2)}</small>
        </button>
        <button className={`panel-button ${props.sidebarOpen ? "active" : ""}`} onClick={props.onToggleSidebar} aria-label={t.panel}><Icon name="layers" /></button>
        <button className="about-button" onClick={props.onOpenAbout} aria-label={t.about}><Icon name="info" /></button>
        <label className="language-select" aria-label={t.language}>
          <select value={props.locale} onChange={(event) => props.onLocaleChange(event.target.value as Locale)} aria-label={t.language}>
            {LOCALES.map((locale) => <option key={locale} value={locale}>{LOCALE_NAMES[locale]}</option>)}
          </select>
        </label>
      </div>
    </header>
  );
}
