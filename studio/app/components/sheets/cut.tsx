"use client";

/**
 * Cut sheet — "this part is taller than the bed; cut it".
 *
 * DELIBERATELY NOT A GIZMO. A draggable cut plane in 3D is the version every
 * desktop slicer ships and the version nobody can use on a phone. The thing
 * people actually want is a height and a decision about the pieces, so that is
 * what this asks for: a slider bounded by the model's own extent, a number for
 * people who know the number, and what to keep. Everything harder stays absent
 * rather than half-present.
 *
 * The height is in the object's LOCAL millimetres along the bed normal, which
 * is the space the geometry is measured in — see cutObject in engine-adapter.
 */

import type { StudioDictionary } from "../../i18n";
import type { CutKeep } from "../../engine-adapter";

export interface CutSheetProps {
  t: StudioDictionary;
  /** The object's extent along the cut normal, in local millimetres. */
  min: number;
  max: number;
  offset: number;
  onOffset: (value: number) => void;
  keep: CutKeep;
  onKeep: (value: CutKeep) => void;
  cap: boolean;
  onCap: (value: boolean) => void;
  busy: boolean;
  onCut: () => void;
}

export default function CutSheet(props: CutSheetProps) {
  const { t, min, max, offset, keep, cap, busy } = props;
  const span = Math.max(0.001, max - min);
  // Rounded to a tenth: a printer resolves 0.1mm at best, so offering more
  // precision than that is a promise the machine cannot keep.
  const step = 0.1;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));

  return (
    <div className="sheet-body cut-body" data-levo-sheet="cut">
      <p className="cut-help">{t.cutHelp}</p>

      <label className="cut-row">
        <span>{t.cutHeight}</span>
        <input
          type="range"
          data-levo-cut="slider"
          min={min}
          max={max}
          step={step}
          value={offset}
          onChange={(event) => props.onOffset(clamp(Number(event.target.value)))}
        />
        <input
          type="number"
          data-levo-cut="height"
          className="cut-number"
          min={min}
          max={max}
          step={step}
          value={Number(offset.toFixed(2))}
          onChange={(event) => props.onOffset(clamp(Number(event.target.value)))}
        />
        <b dir="ltr">mm</b>
      </label>

      <p className="cut-extent" dir="ltr">
        {min.toFixed(1)} – {max.toFixed(1)} mm ({span.toFixed(1)} mm)
      </p>

      <div className="cut-row cut-keep" role="group" aria-label={t.cutKeep}>
        <span>{t.cutKeep}</span>
        {(["both", "lower", "upper"] as CutKeep[]).map((value) => (
          <button
            key={value}
            type="button"
            data-levo-cut-keep={value}
            className={keep === value ? "active" : ""}
            aria-pressed={keep === value}
            onClick={() => props.onKeep(value)}
          >
            {value === "both" ? t.cutKeepBoth : value === "lower" ? t.cutKeepLower : t.cutKeepUpper}
          </button>
        ))}
      </div>

      <label className="cut-row cut-cap">
        <input
          type="checkbox"
          data-levo-cut="cap"
          checked={cap}
          onChange={(event) => props.onCap(event.target.checked)}
        />
        <span><strong>{t.cutCap}</strong><small>{t.cutCapHelp}</small></span>
      </label>

      <button
        type="button"
        className="cut-apply"
        data-levo-cut="apply"
        disabled={busy || span <= 0.001}
        onClick={props.onCut}
      >
        {busy ? t.cutBusy : t.cutApply}
      </button>
    </div>
  );
}
