"use client";

/**
 * Setup sheet (slice S6): printer / quality / strength / support selection.
 *
 * Honesty: the preset row reports the REAL outcome of the S4 profile loader —
 * "verified" appears only when machine+process+filament presets all came from
 * the installed engine build; otherwise the missing preset names are shown as
 * an explicit warning (no silent fallback presented as a documented profile).
 */

import { PROFILES, PROFILE_IDS, QUALITY, STRENGTH, type ProfileId, type QualityId, type StrengthId } from "../../printer-profiles";
import type { MissingPreset } from "../../profile-loader";
import { templateText, type StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export interface SetupSheetProps {
  t: StudioDictionary;
  profileId: ProfileId;
  quality: QualityId;
  strength: StrengthId;
  support: boolean;
  /** Null while the profile is still loading. */
  profileVerified: boolean | null;
  missingPresets: MissingPreset[];
  onProfile: (id: ProfileId) => void;
  onQuality: (id: QualityId) => void;
  onStrength: (id: StrengthId) => void;
  onSupport: (value: boolean) => void;
  onOpenAdvanced: () => void;
  onClose: () => void;
}

export default function SetupSheet(props: SetupSheetProps) {
  const { t } = props;
  return (
    <div className="sheet-body setup-body">
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
      <div className="support-row">
        <span><strong>{t.support}</strong><small>{props.support ? t.auto : t.off}</small></span>
        <button className={`switch ${props.support ? "on" : ""}`} role="switch" aria-checked={props.support} onClick={() => props.onSupport(!props.support)}><i /></button>
      </div>
      <button className="advanced-button" onClick={props.onOpenAdvanced}>
        <span><Icon name="settings" /><b>{t.advanced}</b><small>{t.advancedHelp}</small></span>
        <Icon name="layers" />
      </button>
      <p className="file-limit">{t.fileLimit}</p>
      <button className="sheet-done" onClick={props.onClose}>{t.apply}</button>
    </div>
  );
}
