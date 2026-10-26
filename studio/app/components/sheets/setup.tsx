"use client";

/**
 * Setup sheet (slice S6): printer / quality / strength / infill / support.
 *
 * Honesty: the preset row reports the REAL outcome of the S4 profile loader —
 * "verified" appears only when machine+process+filament presets all came from
 * the installed engine build; otherwise the missing preset names are shown as
 * an explicit warning (no silent fallback presented as a documented profile).
 */

import { INFILL, PROFILES, PROFILE_IDS, QUALITY, STRENGTH, type InfillId, type ProfileId, type QualityId, type StrengthId } from "../../printer-profiles";
import type { MissingPreset } from "../../profile-loader";
import { templateText, type StudioDictionary } from "../../i18n";
import { STUDIO_MODES, type StudioMode } from "../../studio-mode";
import type { ThemePreference } from "../../theme";
import { Icon } from "../header";

export interface SetupSheetProps {
  t: StudioDictionary;
  profileId: ProfileId;
  quality: QualityId;
  strength: StrengthId;
  infill: InfillId;
  support: boolean;
  /** Null while the profile is still loading. */
  profileVerified: boolean | null;
  missingPresets: MissingPreset[];
  onProfile: (id: ProfileId) => void;
  onQuality: (id: QualityId) => void;
  onStrength: (id: StrengthId) => void;
  onInfill: (id: InfillId) => void;
  onSupport: (value: boolean) => void;
  /** P1-10: Simple (the default for everyone) or Advanced. */
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  /** The device-local appearance (app/theme.ts): system, light or dark. */
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  onOpenAdvanced: () => void;
  onClose: () => void;
}

export default function SetupSheet(props: SetupSheetProps) {
  const { t } = props;
  return (
    <div className="sheet-body setup-body">
      {/*
        EDITOR MODE (P1-10) — AT THE TOP OF THE SHEET. Everyone starts in
        Simple, which hides the engine side panel, so a returning person who
        relied on that panel opens Settings to find where it went: the answer
        must be the first thing here, not a block below printer, quality,
        strength, infill and support that a 900px window had to scroll to.
        "All settings" at the bottom still switches to Advanced in Simple.
        The help line under the choice says what stays visible in Simple.
      */}
      <fieldset className="mode-fieldset">
        <legend>{t.modeTitle}</legend>
        <div className="segmented-control mode-control" role="radiogroup" aria-label={t.modeTitle}>
          {STUDIO_MODES.map((id) => (
            <button
              key={id}
              role="radio"
              aria-checked={props.mode === id}
              className={props.mode === id ? "active" : ""}
              data-levo-mode-option={id}
              onClick={() => props.onMode(id)}
            >
              <strong>{id === "simple" ? t.modeSimple : t.modeAdvanced}</strong>
              <span>{id === "simple" ? t.modeSimpleShort : t.modeAdvancedShort}</span>
            </button>
          ))}
        </div>
        <p className="mode-help">{props.mode === "simple" ? t.modeSimpleHelp : t.modeAdvancedHelp}</p>
      </fieldset>
      <fieldset>
        <legend>{t.printer}</legend>
        {/*
          THE CURRENT PRINTER IS FIRST, ALWAYS.

          Fourteen machines in a sheet whose body is about 440px tall on a
          phone is roughly three screens of scrolling, and the one that matters
          — the one already selected — was wherever the declaration order
          happened to put it. So a user opening this sheet to check which
          printer is set had to hunt for the highlighted card.

          Sorting the selected one to the front costs nothing, needs no new
          string (which matters: Sorani here is hand-written and is never
          generated), and answers the question the sheet is usually opened to
          ask before any scrolling happens at all.

          The order is otherwise the declaration order, so the list does not
          reshuffle under the finger as the selection changes — only the
          chosen card moves, and it moves to a place the eye is already on.
        */}
        <div className="profile-grid">
          {[...PROFILE_IDS].sort((a, b) => Number(b === props.profileId) - Number(a === props.profileId)).map((id) => (
            <button
              key={id}
              className={props.profileId === id ? "active" : ""}
              aria-pressed={props.profileId === id}
              onClick={() => props.onProfile(id)}
            >
              <strong>{PROFILES[id].model}</strong>
              <span>{PROFILES[id].bed}</span>
              <small>{PROFILES[id].settingId} · {PROFILES[id].nozzle.toFixed(1)} mm</small>
              {props.profileId === id && <i className="profile-check" aria-hidden="true"><Icon name="check" /></i>}
            </button>
          ))}
        </div>
        {props.profileVerified === true && (
          <p className="profile-status verified"><Icon name="check" /><span>{t.presetVerified}</span></p>
        )}
        {props.profileVerified === false && (
          <p className="profile-status fallback" role="alert">
            <Icon name="warning" />
            <span>{templateText(t.presetFallbackWarning, {
              presets: props.missingPresets.map((preset) => preset.presetName).join(" · ") || "—",
            })}</span>
          </p>
        )}
        {props.profileVerified === null && (
          <p className="profile-status"><span>{t.profileLoading}</span></p>
        )}
      </fieldset>
      <fieldset>
        <legend>{t.quality}</legend>
        <div className="segmented-control">
          {(Object.keys(QUALITY) as QualityId[]).map((id) => (
            <button key={id} className={props.quality === id ? "active" : ""} onClick={() => props.onQuality(id)}>
              <strong>{QUALITY[id].label}</strong>
              <span>{QUALITY[id].layer.toFixed(2)} mm</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t.strength}</legend>
        <div className="segmented-control">
          {(Object.keys(STRENGTH) as StrengthId[]).map((id) => (
            <button key={id} className={props.strength === id ? "active" : ""} onClick={() => props.onStrength(id)}>
              <strong>{STRENGTH[id].label}</strong>
              <span>{STRENGTH[id].infill}% · {STRENGTH[id].walls} walls</span>
            </button>
          ))}
        </div>
      </fieldset>
      {/*
        INFILL PATTERN — THE SHAPE, DIRECTLY UNDER THE AMOUNT.

        «تظيف قائمة اسفل قائمة "القوة" بيها انواع الحشو.» It belongs here and
        nowhere else: Strength above sets how much material goes inside, this
        sets what shape that material takes, and the two are read together.

        Each button carries the engine's own pattern name in bold and the
        purpose underneath — the same two-line shape the Quality and Strength
        controls already use, so the three read as one stack rather than as a
        new kind of control. The names that reach the kernel are pinned in
        printer-profiles.ts; the two the owner named that this engine cannot
        actually print are documented there rather than offered here.
      */}
      <fieldset>
        <legend>{t.infillPattern}</legend>
        <div className="segmented-control">
          {(Object.keys(INFILL) as InfillId[]).map((id) => (
            <button key={id} className={props.infill === id ? "active" : ""} onClick={() => props.onInfill(id)}>
              <strong>{INFILL[id].label}</strong>
              <span>{id === "light" ? t.infillLight : id === "balanced" ? t.infillBalanced : t.infillStrong}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div className="support-row">
        <span><strong>{t.support}</strong><small>{props.support ? t.auto : t.off}</small></span>
        <button className={`switch ${props.support ? "on" : ""}`} role="switch" aria-checked={props.support} onClick={() => props.onSupport(!props.support)}><i /></button>
      </div>
      <button className="advanced-button" onClick={props.onOpenAdvanced}>
        <span><Icon name="settings" /><b>{t.advanced}</b><small>{props.mode === "simple" ? t.modeSwitchHelp : t.advancedHelp}</small></span>
        <Icon name="layers" />
      </button>
      {/*
        APPEARANCE. The phone reaches it from the overflow sheet too; this is
        the desktop's way to it, beside the other settings that belong to
        this device rather than to the project.
      */}
      <fieldset>
        <legend>{t.theme}</legend>
        <div className="theme-segments" role="radiogroup" aria-label={t.theme}>
          {(["system", "light", "dark"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={props.theme === id}
              className={props.theme === id ? "active" : ""}
              onClick={() => props.onTheme(id)}
              data-levo-theme-option={id}
            >
              {id === "system" ? t.themeSystem : id === "light" ? t.themeLight : t.themeDark}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="file-limit">{t.fileLimit}</p>
      <p className="file-limit">{t.webLimitsNotice}</p>
      <button className="sheet-done" onClick={props.onClose}>{t.apply}</button>
    </div>
  );
}
