"use client";

/**
 * PrimarySliceButton — «تقطيع المجسم», the one gold primary on the screen
 * (reference row 9; owner override D-2: the sand gradient, dark ink).
 *
 * Its states are the shell's own `primaryAction`:
 *   idle      «تقطيع المجسم»
 *   stale     «أعد التقطيع» — the result on screen no longer matches
 *   slicing   «إلغاء NN%» over a progress fill, and a tap cancels (through
 *             the adapter, which reaches the engine on every platform);
 *             «↻ 2/3» joins it while the engine retries a failed attempt
 *   sliced    «الطباعة والتصدير» — opens the print sheet; the gold button
 *             always says what pressing it will do next
 *   disabled  no model, or a file still importing
 */

import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export interface PrimarySliceButtonProps {
  t: StudioDictionary;
  slicing: boolean;
  /** 0..1 while slicing. */
  progress: number;
  /** «↻ 2/3» or "" — already formatted by the shell. */
  retrySuffix: string;
  printReady: boolean;
  stale: boolean;
  disabled: boolean;
  onPress: () => void;
}

export default function PrimarySliceButton(props: PrimarySliceButtonProps) {
  const { t } = props;
  const percent = Math.max(0, Math.min(100, Math.round(props.progress * 100)));
  // The percentage is a readout: LTR, so «100%» never reads «%100» in
  // Arabic or Sorani (mandate §5), isolated from the word beside it.
  const label = props.slicing
    ? <>{t.cancel} <bdi dir="ltr">{`${percent}%${props.retrySuffix}`}</bdi></>
    : props.printReady
      ? t.printExport
      : props.stale
        ? t.resliceModel
        : t.sliceModel;
  return (
    <button
      type="button"
      className="m-slice m-only"
      onClick={props.onPress}
      disabled={props.disabled && !props.slicing}
      aria-busy={props.slicing}
      data-levo-action="phone-slice"
      data-state={props.slicing ? "slicing" : props.printReady ? "sliced" : props.stale ? "stale" : "idle"}
    >
      {props.slicing && <span className="m-slice__fill" style={{ width: `${percent}%` }} aria-hidden="true" />}
      <span>{label}</span>
      <Icon name={props.printReady && !props.slicing ? "print" : "layers"} />
    </button>
  );
}
