"use client";

/**
 * ModeSegmented — Simple / Advanced on the page itself (reference row 3).
 *
 * It used to live only inside the Settings sheet. The reference puts it under
 * the import and save buttons, so the mode is one tap from the main screen.
 * The Settings sheet keeps its own copy, first in the sheet, for the desktop.
 *
 * A radiogroup with the selection following focus: Tab lands on the current
 * option, the arrow keys move in the writing direction (left is "next" in
 * Arabic and Sorani), Home and End jump to the ends, and a key it handles
 * goes no further (roving.ts). The current option takes the sand clay (owner
 * override D-3) and says so as aria-checked.
 */

import { useRef, type KeyboardEvent } from "react";
import type { StudioDictionary } from "../../i18n";
import { STUDIO_MODES, type StudioMode } from "../../studio-mode";
import { consumeRovingKey } from "./roving";

export interface ModeSegmentedProps {
  t: StudioDictionary;
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
}

export default function ModeSegmented({ t, mode, onMode }: ModeSegmentedProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // A key the switch handles stops here: it never reaches the engine's
    // arrow nudge on window (roving.ts, c6-r4-ha-02).
    const next = consumeRovingKey(event, index, STUDIO_MODES.length);
    if (next < 0) return;
    onMode(STUDIO_MODES[next]);
    refs.current[next]?.focus();
  };
  return (
    <div className="m-seg" role="radiogroup" aria-label={t.modeTitle} data-levo-control="mode">
      {STUDIO_MODES.map((id, index) => (
        <button
          key={id}
          ref={(node) => { refs.current[index] = node; }}
          type="button"
          role="radio"
          className="m-sel"
          aria-checked={mode === id}
          tabIndex={mode === id ? 0 : -1}
          data-levo-mode-choice={id}
          onClick={() => onMode(id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {id === "simple" ? t.modeSimple : t.modeAdvanced}
        </button>
      ))}
    </div>
  );
}
