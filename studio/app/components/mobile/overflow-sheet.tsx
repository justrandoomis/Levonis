"use client";

/**
 * OverflowSheet — everything the reference screen leaves out, one tap away.
 *
 * NOTHING IS DROPPED. The reference shows four transform tools, five settings
 * and two exports. The editor does far more, and every control the old phone
 * bar and tool tray reached is here, grouped in the order a print is made:
 * files; editing the selected object; the plate; the view and its history;
 * output; settings; the account and the printer; language and appearance;
 * and the platform's status, with the source-code link the AGPL asks for.
 *
 * That link is reachable in two taps from the main screen — «المزيد», then
 * «المصدر وإشعارات المكتبات» — never behind a third (the About sheet keeps
 * its own copy inside the legal details).
 *
 * Every action closes the sheet first and then runs, so its result (a notice,
 * a new sheet, a download) is what the person sees next.
 */

import type { ReactNode } from "react";
import { LOCALES, LOCALE_NAMES, type Locale, type StudioDictionary } from "../../i18n";
import type { ThemePreference } from "../../theme";
import { FileSelectControl, Icon, SIGN_IN_HREF, type IconName } from "../header";
import ChoiceSegments from "./choice-segments";

/** The public source of LEVO Studio (AGPL-3.0-or-later §13), as the About sheet links it. */
export const SOURCE_CODE_URL = "https://github.com/aliamer229/Levo_slicer";

export interface OverflowSheetProps {
  t: StudioDictionary;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  hasObjects: boolean;
  /**
   * True when the engine has an object selected. Duplicate, split and delete
   * act on the selection only; with none they used to run and answer
   * «Select an object to duplicate first» (c6-r4-ha-04).
   */
  hasSelection: boolean;
  importDisabled: boolean;
  plateCount: number;
  canvasMode: "prepare" | "preview";
  printReady: boolean;
  stale: boolean;
  freshPlateCount: number;
  orienting: boolean;
  signedIn: boolean;
  nativeApp: boolean;
  /** Runs an action after closing the sheet. */
  run: (action: OverflowAction) => void;
  onPickFiles: (files: File[]) => void;
}

export type OverflowAction =
  | "projects" | "new-project"
  | "duplicate" | "delete" | "split" | "on-bed" | "paint" | "cut" | "auto-orient" | "delete-all"
  | "add-plate" | "slice-all" | "toggle-preview"
  | "zoom-all" | "zoom-bed" | "undo" | "redo"
  | "makerworld" | "share-gcode" | "export-all" | "print-sheet"
  | "settings" | "all-settings"
  | "sign-out" | "connect" | "about";

function Tile({ icon, label, onClick, disabled, danger, action }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; action: string }) {
  return (
    <button type="button" className={danger ? "danger" : undefined} onClick={onClick} disabled={disabled} data-levo-more={action}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="toolgroup" role="group" aria-label={label}>
      <p className="toolgroup-label">{label}</p>
      {children}
    </div>
  );
}

export default function OverflowSheet(props: OverflowSheetProps) {
  const { t, run } = props;
  const none = !props.hasObjects;
  const tile = (action: OverflowAction, icon: IconName, label: string, options: { disabled?: boolean; danger?: boolean } = {}) => (
    <Tile key={action} action={action} icon={icon} label={label} onClick={() => run(action)} disabled={options.disabled} danger={options.danger} />
  );
  const themes: Array<{ id: ThemePreference; label: string }> = [
    { id: "system", label: t.themeSystem },
    { id: "light", label: t.themeLight },
    { id: "dark", label: t.themeDark },
  ];
  return (
    <div className="sheet-body more-body" data-levo-sheet="more">
      <Group label={t.files}>
        <div className="more-grid">
          <FileSelectControl className="more-add" label={t.add} disabled={props.importDisabled} onFiles={props.onPickFiles}>
            <Icon name="plus" /><span>{t.add}</span>
          </FileSelectControl>
          {tile("projects", "save", t.projects)}
          {tile("new-project", "plus", t.newProject)}
        </div>
      </Group>

      <Group label={t.editTools}>
        <div className="more-grid">
          {tile("duplicate", "copy", t.duplicate, { disabled: none || !props.hasSelection })}
          {tile("split", "split", t.split, { disabled: none || !props.hasSelection })}
          {tile("on-bed", "bed", t.onBed, { disabled: none })}
          {tile("paint", "paint", t.paint, { disabled: none })}
          {tile("cut", "cut", t.cut, { disabled: none })}
          {tile("auto-orient", "orient", t.orient, { disabled: none || props.orienting })}
          {tile("delete", "trash", t.remove, { disabled: none || !props.hasSelection, danger: true })}
        </div>
      </Group>

      <Group label={t.plate}>
        <div className="more-grid">
          {tile("add-plate", "layers", t.addPlate)}
          {props.plateCount > 1 && tile("slice-all", "slice", t.sliceAll, { disabled: none })}
          {tile("delete-all", "trash", t.deleteAll, { disabled: none, danger: true })}
        </div>
      </Group>

      <Group label={t.viewGroup}>
        <div className="more-grid">
          {tile("toggle-preview", "layers", props.canvasMode === "preview" ? t.prepare : t.preview, { disabled: none })}
          {tile("zoom-all", "fit", t.fit)}
          {tile("zoom-bed", "bed", t.bed)}
          {tile("undo", "undo", t.undo)}
          {tile("redo", "redo", t.redo)}
        </div>
      </Group>

      <Group label={t.printExport}>
        <div className="more-grid">
          {tile("makerworld", "save", t.prepareForHandy, { disabled: none })}
          {props.printReady && tile("share-gcode", "share", t.shareFile)}
          {props.freshPlateCount > 1 && tile("export-all", "layers", t.exportAll)}
          {(props.printReady || props.stale) && tile("print-sheet", "print", t.printExport)}
        </div>
      </Group>

      <Group label={t.settings}>
        <div className="more-grid">
          {tile("settings", "settings", t.settings)}
          {tile("all-settings", "layers", t.allSettings)}
        </div>
      </Group>

      <Group label={t.accountGroup}>
        <div className="more-grid">
          {!props.nativeApp && (props.signedIn
            ? tile("sign-out", "check", t.signOut)
            : <a key="sign-in" href={SIGN_IN_HREF} data-levo-more="sign-in"><Icon name="info" /><span>{t.signIn}</span></a>)}
          {tile("connect", "print", t.connectPrinter)}
        </div>
      </Group>

      <Group label={t.language}>
        <ChoiceSegments
          className="locale-segments"
          label={t.language}
          choices={LOCALES.map((id) => ({ id, label: LOCALE_NAMES[id] }))}
          value={props.locale}
          onChoose={props.onLocale}
          followFocus={false}
          dataName="data-levo-locale-option"
        />
      </Group>

      <Group label={t.theme}>
        <ChoiceSegments
          className="theme-segments"
          label={t.theme}
          choices={themes}
          value={props.theme}
          onChoose={props.onTheme}
          followFocus
          dataName="data-levo-theme-option"
        />
      </Group>

      <Group label={t.about}>
        <div className="more-grid">
          {tile("about", "info", t.about)}
        </div>
        <div className="more-links">
          <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer" data-levo-more="source">
            <span>{t.sourceAndNotices}</span><Icon name="external" />
          </a>
          <a href="https://levonis-iq.com/" rel="noreferrer"><span>{t.backToStore}</span><Icon name="external" /></a>
          <a href="https://levonis-iq.com/community" rel="noreferrer"><span>{t.backToCommunity}</span><Icon name="external" /></a>
        </div>
      </Group>
    </div>
  );
}
