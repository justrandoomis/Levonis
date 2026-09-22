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

import { PROFILES, PROFILE_IDS, type ProfileId } from "../../printer-profiles";
import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export interface PrinterChoiceSheetProps {
  t: StudioDictionary;
  /** The card tapped so far, or null while the question is still open. */
  draft: ProfileId | null;
  onDraft: (id: ProfileId) => void;
  onConfirm: (id: ProfileId) => void;
}

export default function PrinterChoiceSheet(props: PrinterChoiceSheetProps) {
  const { t, draft } = props;
  return (
    <div className="sheet-body setup-body printer-choice-body">
      <p className="printer-choice-lede">{t.choosePrinterHelp}</p>
      <div className="profile-grid" role="radiogroup" aria-label={t.choosePrinter}>
        {PROFILE_IDS.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={draft === id}
            className={draft === id ? "active" : ""}
            onClick={() => props.onDraft(id)}
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
