"use client";

/**
 * StudioTopBar — the phone's header row (reference IMG_8466, row 2).
 *
 * Start side: the back chevron to the LEVONIS community and the title block,
 * «LEVO Studio» over «تجهيز ملفات الطباعة». Then «حفظ», which saves now (to
 * the account when signed in, as a draft on this device otherwise; the shell
 * says which), and at the very end «استيراد», the gold-outline import (owner
 * override D-2: gold is its edge, never its fill), as the reference places
 * them.
 *
 * The back link is a plain navigation, so it works with JavaScript off and
 * opens in a new tab on a long press. `onLeave` is asked first and may cancel
 * it: leaving during a slice, or with account changes not yet saved, is
 * confirmed rather than silent.
 */

import type { StudioDictionary } from "../../i18n";
import { FileSelectControl, Icon, STUDIO_BACK_URL } from "../header";

export interface StudioTopBarProps {
  t: StudioDictionary;
  importDisabled: boolean;
  onPickFiles: (files: File[]) => void;
  saveDisabled: boolean;
  saving: boolean;
  onSave: () => void;
  /** Return false to stay on the page. */
  onLeave: () => boolean;
}

export default function StudioTopBar(props: StudioTopBarProps) {
  const { t } = props;
  return (
    <header className="m-topbar m-only">
      <div className="m-topbar__brand">
        <a
          className="m-topbar__back"
          href={STUDIO_BACK_URL}
          aria-label={t.backToSite}
          title={t.backToSite}
          onClick={(event) => { if (!props.onLeave()) event.preventDefault(); }}
        >
          <Icon name="chevronBack" />
        </a>
        <div className="m-topbar__title">
          <strong>{t.title}</strong>
          <span>{t.subtitle}</span>
        </div>
      </div>
      <div className="m-topbar__actions">
        <button
          className="m-btn"
          type="button"
          onClick={props.onSave}
          disabled={props.saveDisabled}
          aria-busy={props.saving}
          data-levo-action="save-now"
        >
          <Icon name="document" /><span>{t.saveNow}</span>
        </button>
        <FileSelectControl className="m-btn m-btn--outline" label={t.import} disabled={props.importDisabled} onFiles={props.onPickFiles}>
          <Icon name="upload" /><span>{t.import}</span>
        </FileSelectControl>
      </div>
    </header>
  );
}
