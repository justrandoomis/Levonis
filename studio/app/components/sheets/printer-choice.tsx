"use client";

/**
 * First-run printer chooser.
 *
 * «لاستوديو ليفو السلايسر خلي الشخص يختار طابعته اول ما يدخل، لان حاليا من
 *  دخلت اختارلي x2d مباشرة، الافضل تخلي المستخدم من البدايه يختار طابعته.»
 *
 * This is the Setup sheet's printer grid with everything else taken away, and
 * with two deliberate differences from it:
 *
 * 1. NOTHING IS PRE-SELECTED. The Setup sheet always has a current printer and
 *    highlights it; here there is no current printer yet, and showing one card
 *    already ticked is exactly the silent pick this sheet exists to replace.
 *    The confirm button stays disabled until a card is tapped, so the editor
 *    cannot start on a machine nobody named.
 *
 * 2. THE ORDER NEVER MOVES. The Setup sheet floats the selected printer to the
 *    front, which is right when you open it to check what is set. Here the
 *    person is reading down an unfamiliar list with a finger on the screen, and
 *    a grid that reshuffles on the first tap would move the next card out from
 *    under them. Declaration order, always.
 *
 * The web-limits line at the bottom is the one place a first-time user is
 * guaranteed to read it — «توضيح بان هذا ليس تطبيق وانما موقع الإمكانيات
 * محدوده وسوف ينزل تطبيق قريبا».
 */

import { useRef, type KeyboardEvent } from "react";
import { PROFILES, PROFILE_IDS, type ProfileId } from "../../printer-profiles";
import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";
import { consumeRovingKey } from "../mobile/roving";

export interface PrinterChoiceSheetProps {
  t: StudioDictionary;
  /** The card tapped so far, or null while the question is still open. */
  draft: ProfileId | null;
  onDraft: (id: ProfileId) => void;
  onConfirm: (id: ProfileId) => void;
}

export default function PrinterChoiceSheet(props: PrinterChoiceSheetProps) {
  const { t, draft } = props;
  /*
   * THE GRID IS ONE RADIOGROUP TO THE KEYBOARD TOO (c6fix-r2-ha-04). All
   * fourteen cards were tab stops and the arrows did nothing. Now Tab lands
   * on the drafted card (the first, while nothing is drafted), and the
   * arrows, Home and End move the draft in the order of the grid; the keys
   * go no further (roving.ts). Moving only drafts: «تطبيق» still confirms.
   */
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const draftIndex = draft ? PROFILE_IDS.indexOf(draft) : -1;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = consumeRovingKey(event, index, PROFILE_IDS.length);
    if (next < 0) return;
    props.onDraft(PROFILE_IDS[next]);
    refs.current[next]?.focus();
  };
  return (
    <div className="sheet-body setup-body printer-choice-body">
      <p className="printer-choice-lede">{t.choosePrinterHelp}</p>
      <div className="profile-grid" role="radiogroup" aria-label={t.choosePrinter}>
        {PROFILE_IDS.map((id, index) => (
          <button
            key={id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={draft === id}
            tabIndex={index === Math.max(draftIndex, 0) ? 0 : -1}
            className={draft === id ? "active" : ""}
            onClick={() => props.onDraft(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <strong>{PROFILES[id].model}</strong>
            <span>{PROFILES[id].bed}</span>
            <small>{PROFILES[id].settingId} · {PROFILES[id].nozzle.toFixed(1)} mm</small>
            {draft === id && <i className="profile-check" aria-hidden="true"><Icon name="check" /></i>}
          </button>
        ))}
      </div>
      <p className="file-limit">{t.webLimitsNotice}</p>
      <button
        className="sheet-done"
        disabled={!draft}
        onClick={() => { if (draft) props.onConfirm(draft); }}
      >
        {t.apply}
      </button>
    </div>
  );
}
