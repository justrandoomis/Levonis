"use client";

/**
 * Sign-out sheet (P1-09) — sign out, optionally removing this account's
 * drafts from the device.
 *
 * The purge is OPTIONAL and EXPLICIT: an unticked box signs out exactly as
 * the plain link always did, and the drafts stay (namespaced to this account,
 * so the next person to sign in never sees them). Ticked, the shell stops
 * every pending autosave first and then removes `user:<id>` drafts only —
 * guest work and other accounts' drafts are never touched.
 */
import { useState } from "react";
import type { StudioDictionary } from "../../i18n";

export interface SignOutSheetProps {
  t: StudioDictionary;
  busy: boolean;
  onConfirm: (purgeDrafts: boolean) => void;
  onCancel: () => void;
}

export default function SignOutSheet({ t, busy, onConfirm, onCancel }: SignOutSheetProps) {
  const [purge, setPurge] = useState(false);
  return (
    <div className="sheet-body signout-body" data-levo-sheet="signout">
      <p className="signout-help">{t.signOutBody}</p>
      <label className="signout-purge">
        <input
          type="checkbox"
          data-levo-signout="purge"
          checked={purge}
          onChange={(event) => setPurge(event.target.checked)}
        />
        <span>
          <strong>{t.signOutPurgeDrafts}</strong>
          <small>{t.signOutPurgeHint}</small>
        </span>
      </label>
      <div className="signout-actions">
        <button type="button" className="signout-confirm" data-levo-signout="confirm" disabled={busy} onClick={() => onConfirm(purge)}>
          {busy ? t.signingOut : t.signOut}
        </button>
        <button type="button" className="signout-cancel" disabled={busy} onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
