"use client";

/**
 * Setup sheet (slice S6): printer / quality / strength / infill / support.
 *
 * Honesty: the preset row reports the REAL outcome of the S4 profile loader —
 * "verified" appears only when machine+process+filament presets all came from
 * the installed engine build; otherwise the missing preset names are shown as
 * an explicit warning (no silent fallback presented as a documented profile).
 */

import { useRef, type KeyboardEvent } from "react";
import { INFILL, PROFILES, PROFILE_IDS, QUALITY, STRENGTH, type InfillId, type ProfileId, type QualityId, type StrengthId } from "../../printer-profiles";
import type { MissingPreset } from "../../profile-loader";
import { templateText, type Locale, type StudioDictionary } from "../../i18n";
import { STUDIO_MODES, type StudioMode } from "../../studio-mode";
import type { ThemePreference } from "../../theme";
import { Icon } from "../header";
import ChoiceSegments from "../mobile/choice-segments";
import { consumeRovingKey } from "../mobile/roving";

interface Tile<T extends string> {
  id: T;
  title: string;
  caption: string;
}

/**
 * ONE RADIOGROUP PER CHOICE: the editor mode, Quality, Strength and the
 * infill pattern (c6fix-r2-ha-04, -05).
 *
 * The tiers were plain buttons whose chosen one differed by a gold edge and
 * gold text alone, so a screen reader heard «Standard 0.20 mm» with nothing
 * saying it was the one in force (WCAG 4.1.2), and the mode radiogroup had
 * no arrow keys and two tab stops. Each group is now a radiogroup of radios:
 * aria-checked on the chosen tile, which also carries the check mark the
 * printer cards and the appearance carry; Tab lands on the chosen tile (the
 * first, before anything is chosen); the arrows, Home and End move the
 * choice in the writing direction of the row, and go no further (roving.ts).
 * Choosing follows the focus, as in the mode switch on the page.
 */
function RadioTiles<T extends string>(props: {
  className: string;
  label: string;
  tiles: ReadonlyArray<Tile<T>>;
  value: T;
  onChoose: (id: T) => void;
  /** The data attribute each tile carries, for the browser checks. */
  dataName?: "data-levo-mode-option" | "data-levo-tier";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = props.tiles.findIndex((tile) => tile.id === props.value);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = consumeRovingKey(event, index, props.tiles.length);
    if (next < 0) return;
    props.onChoose(props.tiles[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className={props.className} role="radiogroup" aria-label={props.label}>
      {props.tiles.map((tile, index) => {
        const checked = index === checkedIndex;
        const data = props.dataName ? { [props.dataName]: tile.id } : {};
        return (
          <button
            key={tile.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === Math.max(checkedIndex, 0) ? 0 : -1}
            className={checked ? "active" : ""}
            onClick={() => props.onChoose(tile.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            {...data}
          >
            <strong>{tile.title}</strong>
            {/* The row is drawn left to right (.segmented-control); a caption
                in Arabic or Sorani («25% · 3 جدران») reads in its own direction. */}
            <span dir="auto">{tile.caption}</span>
            {checked && <i className="tier-check" aria-hidden="true"><Icon name="check" /></i>}
          </button>
        );
      })}
    </div>
  );
}

export interface SetupSheetProps {
  t: StudioDictionary;
  /** For the counted words (the wall count). */
  locale: Locale;
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
  const { t, locale } = props;
  const qualityName: Record<QualityId, string> = { fine: t.qualityFine, standard: t.qualityStandard, draft: t.qualityDraft };
  const strengthName: Record<StrengthId, string> = { light: t.strengthLight, standard: t.strengthStandard, strong: t.strengthStrong };
  const infillPurpose: Record<InfillId, string> = { light: t.infillLight, balanced: t.infillBalanced, strong: t.infillStrong };
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
        <RadioTiles
          className="segmented-control mode-control"
          label={t.modeTitle}
          tiles={STUDIO_MODES.map((id) => ({
            id,
            title: id === "simple" ? t.modeSimple : t.modeAdvanced,
            caption: id === "simple" ? t.modeSimpleShort : t.modeAdvancedShort,
          }))}
          value={props.mode}
          onChoose={(id) => props.onMode(id)}
          dataName="data-levo-mode-option"
        />
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
        <RadioTiles
          className="segmented-control"
          label={t.quality}
          tiles={(Object.keys(QUALITY) as QualityId[]).map((id) => ({
            id,
            title: qualityName[id],
            caption: `${QUALITY[id].layer.toFixed(2)} mm`,
          }))}
          value={props.quality}
          onChoose={(id) => props.onQuality(id)}
          dataName="data-levo-tier"
        />
      </fieldset>
      <fieldset>
        <legend>{t.strength}</legend>
        <RadioTiles
          className="segmented-control"
          label={t.strength}
          tiles={(Object.keys(STRENGTH) as StrengthId[]).map((id) => ({
            id,
            title: strengthName[id],
            caption: `${STRENGTH[id].infill}% · ${templateText(t.wallsCount, { count: STRENGTH[id].walls }, locale)}`,
          }))}
          value={props.strength}
          onChoose={(id) => props.onStrength(id)}
          dataName="data-levo-tier"
        />
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
        <RadioTiles
          className="segmented-control"
          label={t.infillPattern}
          tiles={(Object.keys(INFILL) as InfillId[]).map((id) => ({
            id,
            title: INFILL[id].label,
            caption: infillPurpose[id],
          }))}
          value={props.infill}
          onChoose={(id) => props.onInfill(id)}
          dataName="data-levo-tier"
        />
      </fieldset>
      {/*
        THE SWITCH IS NAMED BY ITS LABEL (c6fix-r2-ha-03): a screen reader
        heard «switch», off, with no name. Its 52 x 30 track keeps its look,
        inside a 44 px target (globals.css .switch).
      */}
      <div className="support-row">
        <span><strong id="setup-support-label">{t.support}</strong><small>{props.support ? t.auto : t.off}</small></span>
        <button type="button" className={`switch ${props.support ? "on" : ""}`} role="switch" aria-checked={props.support} aria-labelledby="setup-support-label" onClick={() => props.onSupport(!props.support)}><i /></button>
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
        <ChoiceSegments
          className="theme-segments"
          label={t.theme}
          choices={[
            { id: "system", label: t.themeSystem },
            { id: "light", label: t.themeLight },
            { id: "dark", label: t.themeDark },
          ]}
          value={props.theme}
          onChoose={props.onTheme}
          followFocus
          dataName="data-levo-theme-option"
        />
      </fieldset>
      <p className="file-limit">{t.fileLimit}</p>
      <p className="file-limit">{t.webLimitsNotice}</p>
      <button className="sheet-done" onClick={props.onClose}>{t.apply}</button>
    </div>
  );
}
