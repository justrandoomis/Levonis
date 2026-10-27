"use client";

/**
 * PrintSettingsCard + SettingRow — the five rows of the reference (row 6):
 * printer, material, layer height, infill and supports, plus «كل الإعدادات»
 * in Advanced mode.
 *
 * HONEST ROWS. The reference reads "PETG" and "20%"; those were placeholders.
 * Every row lists only what the editor can really do:
 *  - material: only the filament presets the installed engine ships for this
 *    printer (printer-profiles.ts materialsFor). The value SHOWN is the
 *    filament on T1 (materialInForce): an imported project that brings PETG
 *    Basic reads «PETG Basic», and any other filament reads as its own short
 *    name with «(مخصص)» («PLA Matte (مخصص)»), never as the selector the file
 *    replaced;
 *  - layer height and infill: the Quality and Strength tiers that exist
 *    (0.12/0.20/0.24 mm, 10/15/25 %). The value SHOWN is the one the kernel
 *    will use — `settings.layer_height` and `settings.sparse_infill_density`
 *    — and when a hand edit in Advanced has moved it off every tier, the row
 *    says «(مخصص)» rather than pretending the tier is still in force.
 *
 * Native <select>s: on a phone they open the platform's own picker, which is
 * accessible and needs no sheet. The printer row is a button instead, because
 * fourteen printers want the existing grid with bed sizes, not a list.
 */

import type { ReactNode } from "react";
import { templateText, type StudioDictionary } from "../../i18n";
import {
  MATERIALS,
  QUALITY,
  STRENGTH,
  type MaterialId,
  type MaterialInForce,
  type QualityId,
  type StrengthId,
} from "../../printer-profiles";
import { Icon, type IconName } from "../header";

export function SettingRow({ icon, label, htmlFor, children }: { icon: IconName; label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="m-setting">
      {htmlFor
        ? <label className="m-setting__label" htmlFor={htmlFor}><Icon name={icon} /><span>{label}</span></label>
        : <span className="m-setting__label"><Icon name={icon} /><span>{label}</span></span>}
      <div className="m-setting__value">
        {children}
        <Icon name="chevronDown" />
      </div>
    </div>
  );
}

export interface PrintSettingsCardProps {
  t: StudioDictionary;
  printerName: string;
  onOpenPrinter: () => void;
  material: MaterialId;
  /** The filament the kernel will use for T1 (settings.filament_settings_id[0]). */
  materialInForce: MaterialInForce;
  materials: readonly MaterialId[];
  onMaterial: (id: MaterialId) => void;
  quality: QualityId;
  /** The layer height the kernel will use (settings.layer_height). */
  effectiveLayer: number;
  onQuality: (id: QualityId) => void;
  strength: StrengthId;
  /** The infill density the kernel will use (settings.sparse_infill_density). */
  effectiveInfill: number;
  onStrength: (id: StrengthId) => void;
  support: boolean;
  onSupport: (value: boolean) => void;
  disabled: boolean;
  showAllSettings: boolean;
  onAllSettings: () => void;
}

const CUSTOM = "custom";

export default function PrintSettingsCard(props: PrintSettingsCardProps) {
  const { t } = props;
  const qualityIds = Object.keys(QUALITY) as QualityId[];
  const strengthIds = Object.keys(STRENGTH) as StrengthId[];
  const layerIsTier = Math.abs(QUALITY[props.quality].layer - props.effectiveLayer) < 0.0005;
  const infillIsTier = Math.abs(STRENGTH[props.strength].infill - props.effectiveInfill) < 0.05;
  const materialShown = props.materialInForce.id;
  // A left-to-right mark first: in an Arabic or Sorani select "0.20 mm"
  // would otherwise be ordered "mm 0.20" (the space between the number and
  // the unit takes the paragraph's direction). Readouts stay LTR (mandate §5).
  const LRM = "\u200e";
  const layerText = (value: number) => `${LRM}${value.toFixed(2)} mm`;
  const infillText = (value: number) => `${LRM}${Math.round(value * 10) / 10}%`;
  return (
    <section className="m-card m-only" aria-labelledby="m-print-settings-title" data-levo-card="print-settings">
      <h2 className="m-card__title" id="m-print-settings-title">{t.printSettings}</h2>

      <SettingRow icon="print" label={t.printer}>
        <button type="button" onClick={props.onOpenPrinter} disabled={props.disabled} aria-haspopup="dialog" aria-label={`${t.printer}: ${props.printerName}`}>
          <span dir="ltr">{props.printerName}</span>
        </button>
      </SettingRow>

      <SettingRow icon="spool" label={t.material} htmlFor="m-material">
        <select
          id="m-material"
          value={materialShown ?? CUSTOM}
          disabled={props.disabled || (props.materials.length < 2 && materialShown === props.material)}
          onChange={(event) => { if (event.target.value !== CUSTOM) props.onMaterial(event.target.value as MaterialId); }}
        >
          {materialShown === null && <option value={CUSTOM} disabled>{templateText(t.customValue, { value: props.materialInForce.label })}</option>}
          {props.materials.map((id) => <option key={id} value={id}>{MATERIALS[id].label}</option>)}
        </select>
      </SettingRow>

      <SettingRow icon="layers" label={t.layerHeight} htmlFor="m-layer">
        <select
          id="m-layer"
          value={layerIsTier ? props.quality : CUSTOM}
          disabled={props.disabled}
          onChange={(event) => { if (event.target.value !== CUSTOM) props.onQuality(event.target.value as QualityId); }}
        >
          {!layerIsTier && <option value={CUSTOM} disabled>{templateText(t.customValue, { value: layerText(props.effectiveLayer) })}</option>}
          {qualityIds.map((id) => <option key={id} value={id}>{layerText(QUALITY[id].layer)}</option>)}
        </select>
      </SettingRow>

      <SettingRow icon="infill" label={t.infill} htmlFor="m-infill">
        <select
          id="m-infill"
          value={infillIsTier ? props.strength : CUSTOM}
          disabled={props.disabled}
          onChange={(event) => { if (event.target.value !== CUSTOM) props.onStrength(event.target.value as StrengthId); }}
        >
          {!infillIsTier && <option value={CUSTOM} disabled>{templateText(t.customValue, { value: infillText(props.effectiveInfill) })}</option>}
          {strengthIds.map((id) => <option key={id} value={id}>{infillText(STRENGTH[id].infill)}</option>)}
        </select>
      </SettingRow>

      <SettingRow icon="supports" label={t.support} htmlFor="m-supports">
        <select
          id="m-supports"
          value={props.support ? "auto" : "off"}
          disabled={props.disabled}
          onChange={(event) => props.onSupport(event.target.value === "auto")}
        >
          <option value="off">{t.off}</option>
          <option value="auto">{t.auto}</option>
        </select>
      </SettingRow>

      {props.showAllSettings && (
        <SettingRow icon="settings" label={t.allSettings}>
          <button type="button" onClick={props.onAllSettings} data-levo-action="all-settings">
            <span>{t.modeAdvancedShort}</span>
          </button>
        </SettingRow>
      )}
    </section>
  );
}
