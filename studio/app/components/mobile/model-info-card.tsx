"use client";

/**
 * ModelInfoCard — the model's size and its print orientation (reference row 7).
 *
 * The size is measured, never typed: app/model-dimensions.ts runs the
 * object's own vertices through its scale and rotation. It shows the selected
 * object, or the only one; with several and none selected it asks for a
 * selection rather than adding sizes that mean nothing together.
 *
 * The three orientation chips are actions with a state: tapping one turns the
 * model (undoable from the message row), and the chip that matches the
 * model's CURRENT rotation is pressed — read from the scene, so a rotation
 * made by hand with the gizmo leaves no chip pressed rather than a stale one.
 */

import type { StudioDictionary } from "../../i18n";
import type { OrientationPreset } from "../../auto-orient";
import { Icon, type IconName } from "../header";

export interface ModelInfoCardProps {
  t: StudioDictionary;
  /** «80 × 40 × 30 mm», or null when there is nothing (or no one thing) to measure. */
  dimensions: string | null;
  /** Shown instead of a size when several objects are on the bed and none is selected. */
  needsSelection: boolean;
  orientation: OrientationPreset | null;
  disabled: boolean;
  onOrient: (preset: OrientationPreset) => void;
}

export default function ModelInfoCard(props: ModelInfoCardProps) {
  const { t } = props;
  const chips: Array<{ id: OrientationPreset; icon: IconName; label: string }> = [
    { id: "imported", icon: "boxUpright", label: t.orientImported },
    { id: "auto", icon: "cubeAuto", label: t.orientAuto },
    { id: "side", icon: "boxSide", label: t.orientSide },
  ];
  return (
    <section className="m-card m-model m-only" data-levo-card="model-info">
      <div>
        <p className="m-model__label"><Icon name="cube" /><span>{t.dimensions}</span></p>
        {props.dimensions
          ? <p className="m-model__dims" dir="ltr" data-levo-readout="dimensions">{props.dimensions}</p>
          : props.needsSelection
            ? <p className="m-model__hint">{t.dimensionsPick}</p>
            : <p className="m-model__dims" aria-label={t.noModelYet}>—</p>}
      </div>
      <span className="m-model__divider" aria-hidden="true" />
      <div role="group" aria-labelledby="m-orient-label">
        <p className="m-model__label" id="m-orient-label">{t.orientation}</p>
        <div className="m-orient">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="m-sel"
              aria-pressed={props.orientation === chip.id}
              aria-label={chip.label}
              title={chip.label}
              disabled={props.disabled}
              onClick={() => props.onOrient(chip.id)}
              data-levo-orient={chip.id}
            >
              <Icon name={chip.icon} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
